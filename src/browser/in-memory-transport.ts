/**
 * The in-memory A2A transport: an implementation of the SDK's `Transport` whose methods
 * call a request handler directly. The SDK `Client` on top of it is the same one every
 * surface uses over HTTP; only the wire is missing, so no bytes leave the process — or,
 * in the browser build, the tab.
 */
import type {
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  SendMessageRequest,
  SendMessageResult,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import { Extensions } from '@a2a-js/sdk';
import type { RequestOptions, Transport } from '@a2a-js/sdk/client';
import { Client } from '@a2a-js/sdk/client';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { UnauthenticatedUser, defaultServerCallContextBuilder } from '@a2a-js/sdk/server';

/** The protocol name the transport reports. It names no binding of the A2A specification. */
export const IN_MEMORY_PROTOCOL = 'IN_MEMORY';

/** The A2A version the transport speaks: the handler is called with 1.0 requests. */
const PROTOCOL_VERSION = '1.0';

/** The service parameters, under the lower-case names HTTP headers arrive with. */
function headersOf(options: RequestOptions | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(options?.serviceParameters ?? {}).map(
      ([name, value]: [string, string]): [string, string] => [name.toLowerCase(), value],
    ),
  );
}

/**
 * The server's view of one call, built from the service parameters exactly as the HTTP
 * bindings build it from request headers: the extensions asked for, the version, and the
 * headers themselves.
 */
function contextOf(options: RequestOptions | undefined): ServerCallContext {
  const headers = headersOf(options);
  const version = headers['a2a-version'];
  return defaultServerCallContextBuilder({
    extensions: Extensions.parseServiceParameter(headers['a2a-extensions']),
    user: new UnauthenticatedUser(),
    headers,
    ...(version === undefined ? {} : { requestedVersion: version }),
  });
}

/**
 * Lets the event loop turn once. Every call through the transport starts with one, as a
 * call over a wire would: a caller that polls in a loop cannot starve timers or rendering.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve: () => void) => {
    setTimeout(resolve, 0);
  });
}

/** Why `signal` aborted, as an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** A promise that rejects with the signal's reason once it aborts, and never resolves. */
function abortion(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_resolve: unknown, reject: (reason: unknown) => void) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
  // Nobody may be racing it when the signal fires; that is not an error.
  aborted.catch(() => undefined);
  return aborted;
}

/**
 * Passes a handler's stream on, copying each event, and ends it — releasing the handler's
 * subscription — when the consumer stops or `signal` aborts.
 *
 * @throws the signal's reason when it aborts, as a `fetch` would.
 */
async function* relay(
  source: AsyncGenerator<StreamResponse, void, undefined>,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamResponse, void, undefined> {
  signal?.throwIfAborted();
  const aborted = signal === undefined ? null : abortion(signal);
  await nextTurn();
  try {
    for (;;) {
      const pending = source.next();
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const next = await (aborted === null ? pending : Promise.race([pending, aborted]));
      if (next.done === true) {
        return;
      }
      yield structuredClone(next.value);
    }
  } finally {
    // The handler may be waiting for its next event; it stops when that arrives.
    source.return().catch(() => undefined);
  }
}

/**
 * An A2A transport onto a request handler in the same process.
 *
 * Invariant: nothing is shared by reference across it. Requests and responses are copied
 * (`structuredClone`), as a wire would copy them, so neither side can change what the
 * other holds.
 */
export class InMemoryTransport implements Transport {
  readonly #handler: A2ARequestHandler;

  constructor(handler: A2ARequestHandler) {
    this.#handler = handler;
  }

  /** Makes one call on the handler and returns a copy of what it answered. */
  async #ask<T>(
    options: RequestOptions | undefined,
    call: (context: ServerCallContext) => Promise<T>,
  ): Promise<T> {
    options?.signal?.throwIfAborted();
    await nextTurn();
    return structuredClone(await call(contextOf(options)));
  }

  /** {@link IN_MEMORY_PROTOCOL}. */
  get protocolName(): string {
    return IN_MEMORY_PROTOCOL;
  }

  /** The A2A version of the requests the handler is given. */
  get protocolVersion(): string {
    return PROTOCOL_VERSION;
  }

  /** The handler's extended agent card. */
  getExtendedAgentCard(
    params: GetExtendedAgentCardRequest,
    options?: RequestOptions,
  ): Promise<AgentCard> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.getAuthenticatedExtendedAgentCard(params, context),
    );
  }

  /** Sends a message and waits for the task or the direct reply. */
  sendMessage(params: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.sendMessage(structuredClone(params), context),
    );
  }

  /** Sends a message and yields the task's events as the handler produces them. */
  sendMessageStream(
    params: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    return relay(
      this.#handler.sendMessageStream(structuredClone(params), contextOf(options)),
      options?.signal,
    );
  }

  /** Stores a push notification configuration; the handler decides whether it may. */
  createTaskPushNotificationConfig(
    params: TaskPushNotificationConfig,
    options?: RequestOptions,
  ): Promise<TaskPushNotificationConfig> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.createTaskPushNotificationConfig(params, context),
    );
  }

  /** Reads a push notification configuration. */
  getTaskPushNotificationConfig(
    params: GetTaskPushNotificationConfigRequest,
    options?: RequestOptions,
  ): Promise<TaskPushNotificationConfig> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.getTaskPushNotificationConfig(params, context),
    );
  }

  /** Lists a task's push notification configurations. */
  listTaskPushNotificationConfig(
    params: ListTaskPushNotificationConfigsRequest,
    options?: RequestOptions,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.listTaskPushNotificationConfigs(params, context),
    );
  }

  /** Removes a push notification configuration. */
  async deleteTaskPushNotificationConfig(
    params: DeleteTaskPushNotificationConfigRequest,
    options?: RequestOptions,
  ): Promise<void> {
    await this.#ask(options, (context: ServerCallContext) =>
      this.#handler.deleteTaskPushNotificationConfig(params, context),
    );
  }

  /** Reads a task. */
  getTask(params: GetTaskRequest, options?: RequestOptions): Promise<Task> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.getTask(params, context),
    );
  }

  /** Cancels a task. */
  cancelTask(params: CancelTaskRequest, options?: RequestOptions): Promise<Task> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.cancelTask(params, context),
    );
  }

  /** Lists tasks. */
  listTasks(params: ListTasksRequest, options?: RequestOptions): Promise<ListTasksResponse> {
    return this.#ask(options, (context: ServerCallContext) =>
      this.#handler.listTasks(params, context),
    );
  }

  /** Yields the events of a task that is already running. */
  resubscribeTask(
    params: SubscribeToTaskRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    return relay(this.#handler.resubscribe(params, contextOf(options)), options?.signal);
  }
}

/** Opens the SDK client on `handler` through an {@link InMemoryTransport}. */
export async function connectInMemory(handler: A2ARequestHandler): Promise<Client> {
  return new Client(new InMemoryTransport(handler), await handler.getAgentCard());
}
