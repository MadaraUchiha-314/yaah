/**
 * yaah's `AgentExecutor`: the one piece of code between the A2A SDK's request handler
 * and the harness. It turns a request into an inbox item, and what the task's run then
 * produces into the events the SDK streams back.
 *
 * Order matters here. The executor notes where the task's stream stands, *then* hands
 * the item to the inbox, then forwards everything after that point — so a run that
 * finishes before the forwarding starts is still seen in full.
 */
import type { Message, Task } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { AgentEvent } from '@a2a-js/sdk/server';

import type { TaskState as CoreState } from '../../harness/core/step-runner.ts';
import type { InboxItem, InboxPayload, TaskModel } from '../../harness/core/types.ts';
import type { DurableExecution } from '../durable/types.ts';
import type { Inbox } from '../inbox/inbox.ts';
import type { Triage } from '../inbox/triage.ts';
import type { StreamHub } from '../stream-hub.ts';
import { callerClosed } from './caller.ts';
import { messageText, metadataObject } from './convert.ts';
import { isOwnBus } from './request-buses.ts';
import { recordFailure } from './request-failure.ts';
import { activityEvent, artifactEvent } from './executor-events.ts';
import type { DurableExecutionTask } from './extensions/index.ts';
import { EXT, SCHEMAS, readExtension } from './extensions/index.ts';
import { isFromDelegate, payloadOf } from './message-payload.ts';
import type { A2aTaskPort, TaskSettings } from './task-port.ts';
import { SETTINGS_KEY, STATUS_KEY, publicTask } from './task-port.ts';
import type { YaahTaskStore } from './task-store.ts';

/** Answers a `/command` without involving the task's run. Provided by the commands plugin. */
export type CommandDispatcher = (request: RequestContext) => Promise<Message | null>;

/** What the executor works with. */
export interface ExecutorDeps {
  readonly store: YaahTaskStore;
  readonly hub: StreamHub;
  readonly inbox: Inbox;
  readonly durable: DurableExecution;
  readonly tasks: A2aTaskPort;
  /** The id of this harness as an agent, used as the assignee of new tasks. */
  readonly agentId: string;
  /** Settings a new task inherits from its context (`/model`, `/effort`). */
  readonly contextSettings?: ((contextId: string) => Partial<TaskSettings>) | undefined;
  readonly commands?: CommandDispatcher | undefined;
  /** Reads the caller key the HTTP layer attached to the request. */
  readonly callerOf?: ((request: RequestContext) => string) | undefined;
  /** Told when the task a request creates exists, so the slot it held can go. */
  readonly onCreated?: ((request: RequestContext) => void) | undefined;
  /** Told when something a caller sent is dropped rather than accepted. */
  readonly onDiscard?: ((taskId: string, reason: string) => void) | undefined;
  /** Told, inside the request that brought it, when an item is about to enter the inbox. */
  readonly onAccept?: ((item: InboxItem, contextId: string) => void) | undefined;
  /** Removes registered credentials from text a caller is told. */
  readonly redact?: ((text: string) => string) | undefined;
  /** Decides whether a message the client did not mark interrupts a working task. */
  readonly triage?: Triage | undefined;
  /** How long the stream may be silent before the task store is consulted. */
  readonly backstopMs?: number | undefined;
}

const NAME_LENGTH = 60;
const DEFAULT_BACKSTOP_MS = 2000;
const RESTING: ReadonlySet<CoreState> = new Set([
  'input-required',
  'completed',
  'canceled',
  'failed',
]);
const SUPPORTED: ReadonlySet<string> = new Set(Object.values(EXT));

function statusKey(task: Task | undefined): unknown {
  const metadata: Readonly<Record<string, unknown>> = { ...task?.metadata };
  return metadata[STATUS_KEY];
}

/** yaah's implementation of the SDK's `AgentExecutor`. */
export class HarnessExecutor implements AgentExecutor {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  execute = async (request: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    try {
      this.#activateExtensions(request);
      const reply = await this.#deps.commands?.(request);
      if (reply !== null && reply !== undefined) {
        bus.publish(AgentEvent.message(reply));
        return;
      }
      await this.#work(request, bus);
    } catch (error) {
      this.#fail(request, bus, error);
    } finally {
      bus.finished();
    }
  };

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    try {
      const task = this.#deps.store.get(taskId);
      if (task === undefined) {
        return;
      }
      const cursor = this.#deps.hub.head(taskId);
      await this.#deps.durable.cancel(taskId);
      await this.#forward(task, cursor, statusKey(task), bus);
    } finally {
      bus.finished();
    }
  };

  /** Hands the request to the inbox and streams the turn it starts. */
  async #work(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const message = request.userMessage;
    const { taskId } = request;
    // A stream begins with the task, whether this message created it or continues it.
    const task =
      request.task === undefined
        ? this.#create(request)
        : (this.#deps.store.get(taskId) ?? request.task);
    // What the client offers for this turn (for example UI catalogs) travels with the task.
    this.#deps.tasks.updateSettings(taskId, { turnMetadata: metadataObject(message.metadata) });
    bus.publish(AgentEvent.task(publicTask(task)));
    const inbox = readExtension(message.metadata, EXT.inboxEvents, SCHEMAS.inboxEventsRequest);
    const id = `${taskId}:${message.messageId}`;
    const payload = payloadOf(message);
    const item: InboxItem = {
      id,
      taskId,
      receivedAt: new Date().toISOString(),
      interrupt: inbox?.interrupt ?? (await this.#triaged(task, id, payload, message)),
      payload,
    };
    if (item.payload.kind === 'event' && !isFromDelegate(task, item.payload.event)) {
      // An event is taken only for a sub-task this task delegated. Anything else is dropped.
      this.#deps.onDiscard?.(taskId, 'event for a task that was not delegated');
      return;
    }
    const cursor = this.#deps.hub.head(taskId);
    const before = statusKey(this.#deps.store.get(taskId));
    this.#deps.onAccept?.(item, task.contextId);
    const outcome = await this.#deps.inbox.accept(item);
    const current = this.#deps.store.get(taskId);
    if (outcome === 'consumed' && current !== undefined && this.#rests(current)) {
      // A message the run has answered already: nothing will happen, so say where it stands.
      this.#publishStatus(current, bus);
      return;
    }
    // Only a bus of the request's own has nobody else to serve once its client is gone.
    const closed = isOwnBus(bus) ? callerClosed(request) : undefined;
    await this.#forward(task, cursor, before, bus, closed);
  }

  /** What triage, when there is one, says about a message for a task that is working. */
  #triaged(task: Task, id: string, payload: InboxPayload, message: Message): Promise<boolean> {
    const { triage } = this.#deps;
    const working = task.status?.state === TaskState.TASK_STATE_WORKING;
    if (triage === undefined || !working || payload.kind !== 'message') {
      return Promise.resolve(false);
    }
    return triage(task.id, id, messageText(message));
  }

  /** Marks as activated the yaah extensions the client asked for. */
  #activateExtensions(request: RequestContext): void {
    for (const uri of request.context.requestedExtensions ?? []) {
      if (SUPPORTED.has(uri)) {
        request.context.addActivatedExtension(uri);
      }
    }
  }

  /** Creates the task for a first message, from the message and its extension data. */
  #create(request: RequestContext): Task {
    const message = request.userMessage;
    const lifecycle = readExtension(
      message.metadata,
      EXT.taskLifecycle,
      SCHEMAS.taskLifecycleRequest,
    );
    const wanted = readExtension(message.metadata, EXT.taskModel, SCHEMAS.taskModelRequest);
    const text = messageText(message);
    const caller = this.#deps.callerOf?.(request) ?? '';
    // Whoever creates a task is its reporter, under the id they declare for themselves.
    const sender = readExtension(message.metadata, EXT.channels, SCHEMAS.channelsMessage)?.from;
    const parentTasks = wanted?.parentTasks ?? [];
    const model: TaskModel = {
      name: wanted?.name ?? text.slice(0, NAME_LENGTH),
      type: wanted?.type,
      goal: wanted?.goal ?? text,
      description: wanted?.description ?? '',
      acceptanceCriteria: wanted?.acceptanceCriteria ?? [],
      subTasks: [],
      parentTasks,
      participants: wanted?.participants ?? [
        { id: sender ?? (caller === '' ? 'user' : caller), role: 'reporter', kind: 'user' },
        { id: this.#deps.agentId, role: 'assignee', kind: 'agent' },
      ],
      depth: wanted?.depth ?? 0,
      schemaVersion: 1,
    };
    const settings: TaskSettings = {
      // Only the creator of a root task can ask for it to stay open.
      longRunning: lifecycle?.longRunning === true && parentTasks.length === 0,
      caller,
      llm: null,
      effort: null,
      turnMetadata: metadataObject(message.metadata),
      ...this.#deps.contextSettings?.(request.contextId),
    };
    const task: Task = {
      id: request.taskId,
      contextId: request.contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      history: [message],
      artifacts: [],
      metadata: {
        [EXT.taskModel]: model,
        [SETTINGS_KEY]: settings,
        ...this.#durableLink(request.taskId),
      },
    };
    this.#deps.store.update(task.id, (existing: Task | undefined) => existing ?? task);
    this.#deps.onCreated?.(request);
    return task;
  }

  /** Where the task's workflow can be watched, as durable-execution extension data. */
  #durableLink(taskId: string): Record<string, DurableExecutionTask> {
    const url = this.#deps.durable.taskUrl(taskId);
    return url === null
      ? {}
      : { [EXT.durableExecution]: { workflowId: `yaah-${taskId}`, runId: '', url } };
  }

  /** Publishes the status `task` has in the store. */
  #publishStatus(task: Task, bus: ExecutionEventBus): void {
    const current = this.#deps.store.get(task.id);
    if (current?.status !== undefined) {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: task.id,
          contextId: task.contextId,
          status: current.status,
          metadata: undefined,
        }),
      );
    }
  }

  /**
   * Forwards what the task's run publishes, from `cursor` on, until the task rests —
   * finished or waiting for input — or `closed` aborts: the caller of a request with a
   * bus of its own went away.
   */
  async #forward(
    task: Task,
    cursor: number,
    before: unknown,
    bus: ExecutionEventBus,
    closed?: AbortSignal,
  ): Promise<void> {
    const { hub, store } = this.#deps;
    const stop = new AbortController();
    const publishStatus = (): void => {
      this.#publishStatus(task, bus);
    };
    const onClosed = (): void => {
      stop.abort();
    };
    if (closed?.aborted === true) {
      stop.abort();
    }
    closed?.addEventListener('abort', onClosed, { once: true });
    // The store is the record. If the stream is silent, ask the store whether the turn
    // ended without our seeing it.
    const backstop = setInterval(() => {
      const current = store.get(task.id);
      if (current !== undefined && statusKey(current) !== before && this.#rests(current)) {
        publishStatus();
        stop.abort();
      }
    }, this.#deps.backstopMs ?? DEFAULT_BACKSTOP_MS);
    try {
      for await (const { event } of hub.subscribe(task.id, cursor, stop.signal)) {
        if (event.type === 'status') {
          publishStatus();
          if (RESTING.has(event.state)) {
            return;
          }
        } else if (event.type === 'activity') {
          bus.publish(AgentEvent.statusUpdate(activityEvent(task, event.activity)));
        } else {
          bus.publish(AgentEvent.artifactUpdate(artifactEvent(task, event)));
        }
      }
    } finally {
      clearInterval(backstop);
      closed?.removeEventListener('abort', onClosed);
      stop.abort();
    }
  }

  #rests(task: Task): boolean {
    const state = task.status?.state;
    return (
      state === TaskState.TASK_STATE_INPUT_REQUIRED ||
      state === TaskState.TASK_STATE_COMPLETED ||
      state === TaskState.TASK_STATE_CANCELED ||
      state === TaskState.TASK_STATE_FAILED
    );
  }

  /**
   * Reports a failure of the executor itself. For a task that existed before this
   * request, the request fails and the task is left alone: its run is still going. A
   * task this request created never got the message, so it is marked failed.
   */
  #fail(request: RequestContext, bus: ExecutionEventBus, error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    const cause = this.#deps.redact?.(raw) ?? raw;
    if (request.task !== undefined) {
      recordFailure(request.context, cause);
      return;
    }
    const created = this.#deps.store.get(request.taskId);
    if (created === undefined) {
      throw new Error(cause);
    }
    const key = `${request.taskId}/-/executor/${request.userMessage.messageId}`;
    void this.#deps.tasks.setStatus(request.taskId, key, {
      state: 'failed',
      subState: null,
      message: [{ type: 'text', text: cause }],
    });
    this.#publishStatus(created, bus);
  }
}
