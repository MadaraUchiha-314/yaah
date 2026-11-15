/**
 * A {@link StepRunner} that performs steps in this process. It owns the task's inbox
 * queue, the interrupt scope and cancellation.
 *
 * Given a journal it is also restartable. Every step result, every inbox read and every
 * interrupt is recorded; a new runner over the same journal replays the loop from the
 * start, answering each of them from the record until it reaches the point the earlier
 * run stopped at — and only then touches the world again.
 */
import type { Json } from '../../kernel/json.ts';
import type { StepJournal } from './persistence.ts';
import type {
  InboxItemRef,
  RetryPolicy,
  RunLimits,
  StepInput,
  StepName,
  StepOutput,
  StepRunner,
} from './step-runner.ts';
import {
  RunAbandonedError,
  TaskCancelledError,
  TurnInterruptedError,
  isRetryable,
  retryDelay,
} from './step-runner.ts';
import type { StepKey, TaskId } from './types.ts';

/** What a step implementation is told about the call. */
export interface StepContext {
  readonly taskId: TaskId;
  readonly key: StepKey;
  /** Aborted when the step should stop: the task was cancelled or the turn interrupted. */
  readonly signal: AbortSignal;
  /**
   * True when an earlier attempt of this step was started and never reported back, and
   * the step is not safe to repeat. The implementation must not perform the effect again;
   * it records that the outcome is unknown instead.
   */
  readonly outcomeUnknown: boolean;
}

/** The implementation of every step. */
export type StepHandlers = {
  readonly [N in StepName]: (ctx: StepContext, input: StepInput<N>) => Promise<StepOutput<N>>;
};

/** Options of {@link DirectRunner}. */
export interface DirectRunnerOptions {
  /** Record results, inbox reads and interrupts here, and replay from it. */
  readonly journal?: StepJournal | undefined;
  /** How a failed step is attempted again. Without it a failure is final. */
  readonly retry?: RetryPolicy | undefined;
  /** Whether a step may be attempted again after a failure or an unknown outcome. */
  readonly isRetrySafe?: ((name: StepName, input: unknown) => boolean) | undefined;
}

interface Waiter {
  readonly resolve: (item: InboxItemRef) => void;
  readonly reject: (error: Error) => void;
}

interface Scope {
  readonly controller: AbortController;
  /** The journal says this scope was interrupted: unrecorded steps must not run. */
  readonly replayInterrupted: boolean;
  readonly index: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Settles as `work` does, or rejects with `signal.reason` when `signal` aborts first. The
 * abort listener is removed either way: the task's signal outlives every step.
 */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let fail = (): void => undefined;
  const stopped = new Promise<never>(
    (_resolve: (value: never) => void, reject: (reason: unknown) => void) => {
      fail = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new TaskCancelledError());
      };
      if (signal.aborted) {
        fail();
      } else {
        signal.addEventListener('abort', fail, { once: true });
      }
    },
  );
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', fail);
  }
}

/**
 * Reads back a journal record. The cast is safe by construction: the record under a key
 * was written by this class from a value of the very type read here.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the type
function recorded<T>(value: Json): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the doc comment
  return value as T;
}

/** A step output or an inbox reference as JSON. Both are plain data by contract. */
function toRecord(value: unknown): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain data by contract
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** An in-process step runner for one task. */
export class DirectRunner implements StepRunner {
  readonly taskId: TaskId;
  readonly limits: RunLimits;
  readonly #handlers: StepHandlers;
  readonly #retry: RetryPolicy | undefined;
  readonly #isRetrySafe: (name: StepName, input: unknown) => boolean;
  readonly #journal: StepJournal | undefined;
  readonly #queue: InboxItemRef[] = [];
  /** Ids of every item ever handed to the loop, so a redelivery is not consumed twice. */
  readonly #seen = new Set<string>();
  readonly #cancel = new AbortController();
  #waiter: Waiter | null = null;
  #scope: Scope | null = null;
  #shield = 0;
  #abandoned = false;
  #reads = 0;
  #drains = 0;
  #scopes = 0;

  constructor(
    taskId: TaskId,
    handlers: StepHandlers,
    limits: RunLimits,
    options: DirectRunnerOptions = {},
  ) {
    this.taskId = taskId;
    this.limits = limits;
    this.#handlers = handlers;
    this.#retry = options.retry;
    this.#isRetrySafe = options.isRetrySafe ?? ((): boolean => true);
    this.#journal = options.journal;
  }

  /** Hands an accepted inbox item to the run. An interrupting item aborts the open scope. */
  deliver(item: InboxItemRef): void {
    if (this.#seen.has(item.id) || this.#queue.some((queued) => queued.id === item.id)) {
      return;
    }
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      this.#seen.add(item.id);
      waiter.resolve(item);
      return;
    }
    this.#queue.push(item);
    const scope = this.#scope;
    if (item.interrupt && scope !== null && !scope.controller.signal.aborted) {
      // Recorded before the abort, so that a replay interrupts the same scope.
      void this.#journal?.record(this.#mark('interrupt', scope.index), true);
      scope.controller.abort(new TurnInterruptedError());
    }
  }

  /** Cancels the task: every wait and every unshielded step rejects. */
  cancel(): void {
    this.#cancel.abort(new TaskCancelledError());
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(new TaskCancelledError());
  }

  /** Stops the run where it is, recording nothing — for a shutdown. */
  abandon(): void {
    this.#abandoned = true;
    this.#cancel.abort(new RunAbandonedError());
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(new RunAbandonedError());
  }

  /** Whether {@link DirectRunner.abandon} was called. */
  get abandoned(): boolean {
    return this.#abandoned;
  }

  /** Whether {@link DirectRunner.cancel} was called. */
  get cancelled(): boolean {
    return this.#cancel.signal.aborted;
  }

  async step<N extends StepName>(
    name: N,
    key: StepKey,
    input: StepInput<N>,
  ): Promise<StepOutput<N>> {
    const earlier = await this.#journal?.get(key);
    if (earlier !== undefined) {
      return recorded<StepOutput<N>>(earlier.result);
    }
    if (this.#scope?.replayInterrupted === true && this.#shield === 0) {
      // The earlier run abandoned this step when its scope was interrupted.
      throw new TurnInterruptedError();
    }
    const signal = this.#signal();
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TaskCancelledError();
    }
    const safe = this.#isRetrySafe(name, input);
    const started = `${key}#started`;
    // A step that must not run twice leaves a mark before it starts. Finding the mark
    // without a result means an earlier attempt was lost mid-flight.
    const outcomeUnknown = !safe && (await this.#journal?.get(started)) !== undefined;
    if (!safe) {
      await this.#journal?.record(started, true);
    }
    const ctx: StepContext = { taskId: this.taskId, key, signal, outcomeUnknown };
    const result = await this.#attempt(name, ctx, input, safe);
    await this.#journal?.record(key, toRecord(result));
    return result;
  }

  /** Performs a step, trying again per the retry policy while that is safe and useful. */
  async #attempt<N extends StepName>(
    name: N,
    ctx: StepContext,
    input: StepInput<N>,
    safe: boolean,
  ): Promise<StepOutput<N>> {
    const handler = this.#handlers[name];
    for (let attempt = 1; ; attempt += 1) {
      const unknown = ctx.outcomeUnknown || (!safe && attempt > 1);
      const work = handler({ ...ctx, outcomeUnknown: unknown }, input);
      // A step that ignores its signal must not hold the loop: the abort wins the race.
      work.catch(() => {
        // The race below reports the failure; this keeps a late rejection from being unhandled.
      });
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by nature
        const result = await untilAborted(work, ctx.signal);
        return result;
      } catch (error) {
        const policy = this.#retry;
        const final =
          ctx.signal.aborted ||
          policy === undefined ||
          attempt >= policy.maximumAttempts ||
          !isRetryable(error);
        if (final) {
          throw error;
        }
        // oxlint-disable-next-line no-await-in-loop -- the wait between attempts
        await untilAborted(sleep(retryDelay(policy, attempt + 1)), ctx.signal);
      }
    }
  }

  async nextInboxItem(): Promise<InboxItemRef> {
    const mark = this.#mark('inbox', this.#reads);
    this.#reads += 1;
    const earlier = await this.#journal?.get(mark);
    if (earlier !== undefined) {
      const item = recorded<InboxItemRef>(earlier.result);
      this.#taken([item]);
      return item;
    }
    const item = await this.#take();
    await this.#journal?.record(mark, toRecord(item));
    return item;
  }

  async drainInbox(): Promise<readonly InboxItemRef[]> {
    const mark = this.#mark('drain', this.#drains);
    this.#drains += 1;
    const earlier = await this.#journal?.get(mark);
    if (earlier !== undefined) {
      const items = recorded<readonly InboxItemRef[]>(earlier.result);
      this.#taken(items);
      return items;
    }
    const items = this.#queue.splice(0);
    this.#taken(items);
    // Empty drains are recorded too: a replay must see nothing where the first run did.
    await this.#journal?.record(mark, toRecord(items));
    return items;
  }

  async interruptible<T>(body: () => Promise<T>): Promise<T> {
    const index = this.#scopes;
    this.#scopes += 1;
    const earlier = await this.#journal?.get(this.#mark('interrupt', index));
    this.#scope = {
      controller: new AbortController(),
      replayInterrupted: earlier !== undefined,
      index,
    };
    try {
      const result = await body();
      return result;
    } finally {
      this.#scope = null;
    }
  }

  async shielded<T>(body: () => Promise<T>): Promise<T> {
    this.#shield += 1;
    try {
      const result = await body();
      return result;
    } finally {
      this.#shield -= 1;
    }
  }

  /** Waits for the next live item. */
  #take(): Promise<InboxItemRef> {
    if (this.cancelled) {
      const reason: unknown = this.#cancel.signal.reason;
      return Promise.reject(reason instanceof Error ? reason : new TaskCancelledError());
    }
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      this.#seen.add(queued.id);
      return Promise.resolve(queued);
    }
    return new Promise((resolve: Waiter['resolve'], reject: Waiter['reject']) => {
      this.#waiter = { resolve, reject };
    });
  }

  /** Remembers items handed to the loop and drops any copy still queued. */
  #taken(items: readonly InboxItemRef[]): void {
    for (const item of items) {
      this.#seen.add(item.id);
      const index = this.#queue.findIndex((queued) => queued.id === item.id);
      if (index !== -1) {
        this.#queue.splice(index, 1);
      }
    }
  }

  /** The journal key of a non-step record: an inbox read, a drain or an interrupt. */
  #mark(kind: 'inbox' | 'drain' | 'interrupt', index: number): StepKey {
    return `${this.taskId}/-/${kind}/${String(index)}`;
  }

  /** The signal a step started now should obey. */
  #signal(): AbortSignal {
    if (this.#shield > 0 && !this.#abandoned) {
      return new AbortController().signal;
    }
    const scope = this.#scope;
    return scope === null
      ? this.#cancel.signal
      : AbortSignal.any([this.#cancel.signal, scope.controller.signal]);
  }
}
