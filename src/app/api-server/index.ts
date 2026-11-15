/**
 * The API-server plugin: the inbox, yaah's executor and the A2A request handler built
 * from the official SDK. Provides the `a2a` service. It has no listener of its own — the
 * HTTP plugin mounts it on a port, and the browser build calls it in memory.
 */
import type { AgentCard, AgentExtension } from '@a2a-js/sdk';
import type { A2ARequestHandler, RequestContext } from '@a2a-js/sdk/server';
import { STATE_HEADERS_KEY } from '@a2a-js/sdk/server';
import type { Context } from 'cordis';

import { isTerminal } from '../../harness/core/transitions.ts';
import type { InboxItem } from '../../harness/core/types.ts';
import { VERSION } from '../../kernel/version.ts';
import { Inbox } from '../inbox/inbox.ts';
import { createTriage } from '../inbox/triage.ts';
import type { Admission } from './admission.ts';
import { AdmissionGate } from './admission.ts';
import { buildAgentCard } from './agent-card.ts';
import { fromA2aState } from './convert.ts';
import type { CommandDispatcher } from './executor.ts';
import { emptyMessageAdmission } from './empty-message.ts';
import { partSizeAdmission } from './part-limit.ts';
import { HarnessExecutor } from './executor.ts';
import type { CommandInfo } from './extensions/index.ts';
import { CALLER_HEADER } from './guards.ts';
import { SLOT_HEADER, TaskSlots } from './task-slots.ts';
import type { YaahTaskStore } from './task-store.ts';
import { handlerFacing } from './task-store.ts';
import type { TaskSettings } from './task-port.ts';
import { readSettings } from './task-port.ts';

/** The A2A side of the harness. */
export interface A2aService {
  readonly inbox: Inbox;
  /**
   * Builds the request handler for a harness reachable at `baseUrl`. The card — and so
   * the handler — can only be built once the address is known.
   */
  handlerFor(baseUrl: string): A2ARequestHandler;
  /** The agent card for a harness reachable at `baseUrl`. */
  cardFor(baseUrl: string): AgentCard;
  /** How many tasks `caller` has open. */
  openTasks(caller: string): number;
  /** Open-task slots held by requests whose task does not exist yet. */
  readonly slots: TaskSlots;
  /** Adds an extension to the agent card. Returns a function that removes it. */
  addExtension(extension: AgentExtension): () => void;
  /** Sets the function that answers `/commands`, and what is listed in the card. */
  setCommands(dispatch: CommandDispatcher, list: () => readonly CommandInfo[]): () => void;
  /**
   * Adds a function asked about every message no command answered, before the message
   * enters the inbox. A reply it returns is the answer and the message goes no further;
   * null lets it through. Asked in the order added. Returns a function that removes it.
   */
  addInterceptor(intercept: CommandDispatcher): () => void;
  /** Sets where a new task's inherited settings (model, effort) come from. */
  setContextSettings(read: ContextSettings): () => void;
  /**
   * Adds a check every incoming message must pass before a task is created or anything
   * reaches the inbox; a refusal is answered with an A2A error. Returns a function that
   * removes it.
   */
  addAdmission(check: Admission): () => void;
}

/** Reads the settings a conversation chose, for the tasks it creates. */
export type ContextSettings = (contextId: string) => Partial<TaskSettings>;

declare module 'cordis' {
  interface Context {
    /** The A2A request handling of this harness. */
    a2a: A2aService;
  }
  interface Events {
    /**
     * A message is about to enter a task's inbox. Emitted synchronously inside the
     * request that carried it, so a listener sees that request's async scope.
     */
    'inbox/accepted'(item: InboxItem, contextId: string): void;
    /** Something a caller sent was dropped instead of being accepted. */
    'inbox/discarded'(taskId: string, reason: string): void;
  }
}

export const name = 'api-server';
export const inject: readonly string[] = [
  'config',
  'entities',
  'taskRuntime',
  'durable',
  'persistence',
  'strings',
  'redactor',
];

function headerOf(request: RequestContext, header: string): string {
  const headers: unknown = request.context.state.get(STATE_HEADERS_KEY);
  const fields: Readonly<Record<string, unknown>> =
    typeof headers === 'object' && headers !== null ? { ...headers } : {};
  const value = fields[header];
  return typeof value === 'string' ? value : '';
}

function callerOf(request: RequestContext): string {
  return headerOf(request, CALLER_HEADER);
}

/**
 * Who is calling, how what a caller is told is redacted, the release of the open-task
 * slot a request held once its task exists, and reports of what the inbox takes and what
 * it drops as events other plugins can hear.
 */
function callerAndEvents(
  ctx: Context,
  slots: TaskSlots,
): {
  agentId: string;
  callerOf: (request: RequestContext) => string;
  onCreated: (request: RequestContext) => void;
  redact: (text: string) => string;
  onAccept: (item: InboxItem, contextId: string) => void;
  onDiscard: (taskId: string, reason: string) => void;
} {
  return {
    agentId: 'self',
    callerOf,
    onCreated: (request: RequestContext): void => {
      slots.release(headerOf(request, SLOT_HEADER));
    },
    redact: (text: string): string => ctx.redactor.redactString(text),
    onAccept: (item: InboxItem, contextId: string): void => {
      ctx.emit('inbox/accepted', item, contextId);
    },
    onDiscard: (taskId: string, reason: string): void => {
      ctx.emit('inbox/discarded', taskId, reason);
    },
  };
}

/** Asks the command dispatcher, then each interceptor; the first reply is the answer. */
async function firstReply(
  commands: readonly CommandDispatcher[],
  interceptors: ReadonlySet<CommandDispatcher>,
  request: RequestContext,
): ReturnType<CommandDispatcher> {
  for (const answer of [...commands, ...interceptors]) {
    // oxlint-disable-next-line no-await-in-loop -- asked in order; the first reply ends it
    const reply = await answer(request);
    if (reply !== null) {
      return reply;
    }
  }
  return null;
}

/** Builds the function that adds an item to `set` and returns the function removing it. */
function adderTo<T>(set: Set<T>): (item: T) => () => void {
  return (item: T): (() => void) => {
    set.add(item);
    return (): void => {
      set.delete(item);
    };
  };
}

/** The checks every message passes whatever the composition: not empty, no oversized part. */
function standingAdmission(maxPartBytes: number): Admission {
  const partSize = partSizeAdmission(maxPartBytes);
  return async (message): Promise<void> => {
    await emptyMessageAdmission(message);
    await partSize(message);
  };
}

/** An admission gate holding the standing checks. */
function standingGate(maxPartBytes: number): AdmissionGate {
  const gate = new AdmissionGate();
  gate.add(standingAdmission(maxPartBytes));
  return gate;
}

/** Counts the open tasks in `store` a caller created. */
function openTasksIn(store: YaahTaskStore): (caller: string) => number {
  return (caller: string): number =>
    store.open().filter((task) => readSettings(task).caller === caller).length;
}

/** Whether a task in `store` has reached a terminal state. An unknown task has not. */
function closedIn(store: YaahTaskStore): (taskId: string) => boolean {
  return (taskId: string): boolean => {
    const state = store.get(taskId)?.status?.state;
    return state !== undefined && isTerminal(fromA2aState(state));
  };
}

/** Builds the A2A service and picks open tasks up again. */
export function apply(ctx: Context): void {
  const { taskRuntime: runtime, durable, strings } = ctx;
  const inbox = new Inbox(ctx.persistence.inbox, durable, closedIn(runtime.taskStore));
  const extensions = new Set<AgentExtension>();
  const gate = standingGate(ctx.config.limits.maxPartBytes);
  let commands: { dispatch: CommandDispatcher; list: () => readonly CommandInfo[] } | null = null;
  let contextSettings: ContextSettings | null = null;
  const interceptors = new Set<CommandDispatcher>();
  const slots = new TaskSlots();
  const executor = new HarnessExecutor({
    store: runtime.taskStore,
    hub: runtime.hub,
    inbox,
    durable,
    tasks: runtime.tasks,
    ...callerAndEvents(ctx, slots),
    triage: ctx.config.inbox.triage === 'system-one' ? createTriage(ctx) : undefined,
    contextSettings: (contextId: string): Partial<TaskSettings> =>
      contextSettings === null ? {} : contextSettings(contextId),
    commands: (request: RequestContext): ReturnType<CommandDispatcher> =>
      firstReply(commands === null ? [] : [commands.dispatch], interceptors, request),
  });
  const cardFor = (baseUrl: string): AgentCard =>
    buildAgentCard({
      name: strings.t('agent.name'),
      description: strings.t('agent.description'),
      version: VERSION,
      baseUrl,
      commands: commands?.list() ?? [],
      durable: { mode: durable.mode, dashboardUrl: durable.dashboard()?.url ?? null },
      extensions: [...extensions],
    });
  ctx.provide('a2a', {
    inbox,
    cardFor,
    handlerFor: (baseUrl: string): A2ARequestHandler =>
      gate.handler(() => cardFor(baseUrl), handlerFacing(runtime.taskStore), executor),
    addAdmission: (check: Admission): (() => void) => gate.add(check),
    slots,
    openTasks: openTasksIn(runtime.taskStore),
    addExtension: adderTo(extensions),
    setCommands: (
      dispatch: CommandDispatcher,
      list: () => readonly CommandInfo[],
    ): (() => void) => {
      commands = { dispatch, list };
      return (): void => {
        commands = null;
      };
    },
    addInterceptor: adderTo(interceptors),
    setContextSettings: (read: ContextSettings): (() => void) => {
      contextSettings = read;
      return (): void => {
        contextSettings = null;
      };
    },
  });
  recoverWhenReady(ctx, inbox);
}

/**
 * After a restart: every open task gets its run back, then what was accepted but not
 * consumed is handed to those runs again. This waits until the whole harness is up — a
 * recovered run may call a model or a tool at once.
 */
function recoverWhenReady(ctx: Context, inbox: Inbox): void {
  ctx.on('harness/ready', async () => {
    await ctx.durable.recover(ctx.taskRuntime.taskStore.open().map((task) => task.id));
    await inbox.redeliverPending();
  });
}
