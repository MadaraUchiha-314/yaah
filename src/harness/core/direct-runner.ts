/**
 * A {@link StepRunner} that performs steps in this process. It owns the task's inbox
 * queue, the interrupt scope and cancellation; durability (a journal, retries) is layered
 * on top of it by the in-process durable mode.
 */
import type {
  InboxItemRef,
  RunLimits,
  StepInput,
  StepName,
  StepOutput,
  StepRunner,
} from './step-runner.ts';
import { TaskCancelledError, TurnInterruptedError } from './step-runner.ts';
import type { StepKey, TaskId } from './types.ts';

/** What a step implementation is told about the call. */
export interface StepContext {
  readonly taskId: TaskId;
  readonly key: StepKey;
  /** Aborted when the step should stop: the task was cancelled or the turn interrupted. */
  readonly signal: AbortSignal;
}

/** The implementation of every step. */
export type StepHandlers = {
  readonly [N in StepName]: (ctx: StepContext, input: StepInput<N>) => Promise<StepOutput<N>>;
};

/** Performs one step; a wrapper may add a journal or retries around `perform`. */
export type StepInvoker = <N extends StepName>(
  name: N,
  ctx: StepContext,
  input: StepInput<N>,
  perform: () => Promise<StepOutput<N>>,
) => Promise<StepOutput<N>>;

const DIRECT: StepInvoker = (_name, _ctx, _input, perform) => perform();

interface Waiter {
  readonly resolve: (item: InboxItemRef) => void;
  readonly reject: (error: Error) => void;
}

/** Rejects with `signal.reason` when `signal` aborts. Never resolves. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve: (value: never) => void, reject: (reason: unknown) => void) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new TaskCancelledError());
    };
    if (signal.aborted) {
      fail();
    } else {
      signal.addEventListener('abort', fail, { once: true });
    }
  });
}

/** An in-process step runner for one task. */
export class DirectRunner implements StepRunner {
  readonly taskId: TaskId;
  readonly limits: RunLimits;
  readonly #handlers: StepHandlers;
  readonly #invoke: StepInvoker;
  readonly #queue: InboxItemRef[] = [];
  readonly #cancel = new AbortController();
  #waiter: Waiter | null = null;
  #scope: AbortController | null = null;
  #shield = 0;

  constructor(
    taskId: TaskId,
    handlers: StepHandlers,
    limits: RunLimits,
    invoke: StepInvoker = DIRECT,
  ) {
    this.taskId = taskId;
    this.limits = limits;
    this.#handlers = handlers;
    this.#invoke = invoke;
  }

  /** Hands an accepted inbox item to the run. An interrupting item aborts the open scope. */
  deliver(item: InboxItemRef): void {
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter.resolve(item);
      return;
    }
    this.#queue.push(item);
    if (item.interrupt) {
      this.#scope?.abort(new TurnInterruptedError());
    }
  }

  /** Cancels the task: every wait and every unshielded step rejects. */
  cancel(): void {
    this.#cancel.abort(new TaskCancelledError());
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(new TaskCancelledError());
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
    const signal = this.#signal();
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TaskCancelledError();
    }
    const ctx: StepContext = { taskId: this.taskId, key, signal };
    const handler = this.#handlers[name];
    const work = this.#invoke(name, ctx, input, () => handler(ctx, input));
    // A step that ignores its signal must not hold the loop: the abort wins the race.
    work.catch(() => {
      // The race below reports the failure; this keeps a late rejection from being unhandled.
    });
    const result = await Promise.race([work, aborted(signal)]);
    return result;
  }

  nextInboxItem(): Promise<InboxItemRef> {
    if (this.cancelled) {
      return Promise.reject(new TaskCancelledError());
    }
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve: Waiter['resolve'], reject: Waiter['reject']) => {
      this.#waiter = { resolve, reject };
    });
  }

  drainInbox(): readonly InboxItemRef[] {
    return this.#queue.splice(0);
  }

  async interruptible<T>(body: () => Promise<T>): Promise<T> {
    const scope = new AbortController();
    this.#scope = scope;
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

  /** The signal a step started now should obey. */
  #signal(): AbortSignal {
    if (this.#shield > 0) {
      return new AbortController().signal;
    }
    const scope = this.#scope;
    return scope === null
      ? this.#cancel.signal
      : AbortSignal.any([this.#cancel.signal, scope.signal]);
  }
}
