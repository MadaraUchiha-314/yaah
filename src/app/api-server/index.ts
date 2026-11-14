/**
 * The API-server plugin: the inbox, yaah's executor and the A2A request handler built
 * from the official SDK. Provides the `a2a` service. It has no listener of its own — the
 * HTTP plugin mounts it on a port, and the browser build calls it in memory.
 */
import type { AgentCard, AgentExtension } from '@a2a-js/sdk';
import type { A2ARequestHandler, RequestContext } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, STATE_HEADERS_KEY } from '@a2a-js/sdk/server';
import type { Context } from 'cordis';

import type { InboxItem } from '../../harness/core/types.ts';
import { VERSION } from '../../kernel/version.ts';
import { Inbox } from '../inbox/inbox.ts';
import { createTriage } from '../inbox/triage.ts';
import { buildAgentCard } from './agent-card.ts';
import type { CommandDispatcher } from './executor.ts';
import { HarnessExecutor } from './executor.ts';
import type { CommandInfo } from './extensions/index.ts';
import { CALLER_HEADER } from './guards.ts';
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
  /** Adds an extension to the agent card. Returns a function that removes it. */
  addExtension(extension: AgentExtension): () => void;
  /** Sets the function that answers `/commands`, and what is listed in the card. */
  setCommands(dispatch: CommandDispatcher, list: () => readonly CommandInfo[]): () => void;
  /** Sets where a new task's inherited settings (model, effort) come from. */
  setContextSettings(read: ContextSettings): () => void;
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
];

function callerOf(request: RequestContext): string {
  const headers: unknown = request.context.state.get(STATE_HEADERS_KEY);
  const fields: Readonly<Record<string, unknown>> =
    typeof headers === 'object' && headers !== null ? { ...headers } : {};
  const caller = fields[CALLER_HEADER];
  return typeof caller === 'string' ? caller : '';
}

/**
 * Who is calling, and reports of what the inbox takes and what it drops as events other
 * plugins can hear.
 */
function callerAndEvents(ctx: Context): {
  agentId: string;
  callerOf: (request: RequestContext) => string;
  onAccept: (item: InboxItem, contextId: string) => void;
  onDiscard: (taskId: string, reason: string) => void;
} {
  return {
    agentId: 'self',
    callerOf,
    onAccept: (item: InboxItem, contextId: string): void => {
      ctx.emit('inbox/accepted', item, contextId);
    },
    onDiscard: (taskId: string, reason: string): void => {
      ctx.emit('inbox/discarded', taskId, reason);
    },
  };
}

/** Builds the A2A service and picks open tasks up again. */
export function apply(ctx: Context): void {
  const { taskRuntime: runtime, durable, strings } = ctx;
  const inbox = new Inbox(ctx.persistence.inbox, durable);
  const extensions = new Set<AgentExtension>();
  let commands: { dispatch: CommandDispatcher; list: () => readonly CommandInfo[] } | null = null;
  let contextSettings: ContextSettings | null = null;
  const executor = new HarnessExecutor({
    store: runtime.taskStore,
    hub: runtime.hub,
    inbox,
    durable,
    tasks: runtime.tasks,
    ...callerAndEvents(ctx),
    triage: ctx.config.inbox.triage === 'system-one' ? createTriage(ctx) : undefined,
    contextSettings: (contextId: string): Partial<TaskSettings> =>
      contextSettings === null ? {} : contextSettings(contextId),
    commands: (request: RequestContext): ReturnType<CommandDispatcher> =>
      commands === null ? Promise.resolve(null) : commands.dispatch(request),
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
      new DefaultRequestHandler(cardFor(baseUrl), handlerFacing(runtime.taskStore), executor),
    openTasks: (caller: string): number =>
      runtime.taskStore.open().filter((task) => readSettings(task).caller === caller).length,
    addExtension: (extension: AgentExtension): (() => void) => {
      extensions.add(extension);
      return (): void => {
        extensions.delete(extension);
      };
    },
    setCommands: (
      dispatch: CommandDispatcher,
      list: () => readonly CommandInfo[],
    ): (() => void) => {
      commands = { dispatch, list };
      return (): void => {
        commands = null;
      };
    },
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
