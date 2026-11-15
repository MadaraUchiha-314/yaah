/**
 * The seam between the core loop and the world. The loop is deterministic computation
 * over a {@link StepRunner}; everything with an effect — a model call, a tool call, a
 * store write, a wait — is a step the runner performs. Two runners exist: one executes
 * steps in this process, the other is a Temporal workflow whose steps are activities.
 */
import { YaahError } from '../../kernel/yaah-error.ts';
import type { StepKey, TaskId, TokenUsage, ToolCall } from './types.ts';

/** The states of a task as the core sees them. They map one-to-one to A2A task states. */
export type TaskState = 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';

/** Why a task rests in `input-required`. An open set: more will be added. */
export type TaskSubState = 'awaiting-next-interaction' | 'awaiting-user-input';

/** What the loop needs to know about an inbox item without loading its content. */
export interface InboxItemRef {
  readonly id: string;
  readonly kind: 'message' | 'action' | 'event';
  readonly interrupt: boolean;
}

/** A change of task status the loop asks for. */
export type TransitionRequest =
  | { readonly reason: 'turn-start' }
  /** The model answered and asked for nothing more. */
  | { readonly reason: 'turn-complete' }
  | { readonly reason: 'ask-user'; readonly callId: string; readonly question: string }
  | { readonly reason: 'client-complete' }
  | { readonly reason: 'cancel' }
  | { readonly reason: 'error'; readonly cause: string };

/** The status a transition produced. */
export interface TransitionResult {
  readonly state: TaskState;
  readonly subState: TaskSubState | null;
}

/** Input and output of every step. Outputs are small: ids, counts and flags, never content. */
export interface StepContract {
  /** Moves inbox items into the conversation and marks them processed. */
  'conversation.accept': {
    readonly input: { readonly itemIds: readonly string[]; readonly asResultOf?: string };
    readonly output: { readonly accepted: number };
  };
  /** Measures the context the next model call would send. */
  'context.build': {
    readonly input: Record<string, never>;
    readonly output: { readonly estimatedTokens: number; readonly compact: boolean };
  };
  /** Replaces older conversation with a summary. */
  'context.compact': {
    readonly input: Record<string, never>;
    readonly output: { readonly before: number; readonly after: number };
  };
  /** Calls the model once and stores what it said. */
  'llm.invoke': {
    readonly input: Record<string, never>;
    readonly output: { readonly toolCalls: readonly ToolCall[]; readonly usage: TokenUsage };
  };
  /** Runs one tool call and stores its result. */
  'tool.invoke': {
    readonly input: { readonly call: ToolCall };
    readonly output: { readonly ok: boolean };
  };
  /** Changes the task's status. */
  'task.transition': {
    readonly input: TransitionRequest;
    readonly output: TransitionResult;
  };
}

/** The name of a step. */
export type StepName = keyof StepContract;
/** The input of step `N`. */
export type StepInput<N extends StepName> = StepContract[N]['input'];
/** The output of step `N`. */
export type StepOutput<N extends StepName> = StepContract[N]['output'];

/** How a failed step is attempted again. */
export interface RetryPolicy {
  /** Wait before the second attempt. */
  readonly initialIntervalMs: number;
  /** Each wait is the previous one multiplied by this. */
  readonly backoffCoefficient: number;
  /** No wait is longer than this. */
  readonly maximumIntervalMs: number;
  /** Attempts in total, the first included. */
  readonly maximumAttempts: number;
}

/** The policy used when none is configured: 1 s, doubling, capped at 60 s, 5 attempts. */
export const DEFAULT_RETRY: RetryPolicy = {
  initialIntervalMs: 1000,
  backoffCoefficient: 2,
  maximumIntervalMs: 60_000,
  maximumAttempts: 5,
};

/** The wait before attempt number `attempt` (2 is the first retry). */
export function retryDelay(policy: RetryPolicy, attempt: number): number {
  const wait = policy.initialIntervalMs * policy.backoffCoefficient ** (attempt - 2);
  return Math.min(wait, policy.maximumIntervalMs);
}

/**
 * Whether trying again can help. A provider says so itself (`retryable`); an error yaah
 * raised on purpose is final; anything else — a dropped connection, a busy store — is
 * worth another attempt.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return error.retryable === true;
  }
  return !(error instanceof YaahError);
}

/** Bounds on one task's run. */
export interface RunLimits {
  /** Most model calls in one turn. */
  readonly maxIterations: number;
  /** Most input plus output tokens over the task's life. */
  readonly maxTaskTokens: number;
}

/** Everything the loop may do that is not deterministic computation. */
export interface StepRunner {
  readonly taskId: TaskId;
  readonly limits: RunLimits;
  /**
   * Performs step `name` once and returns its result. A step whose result is already
   * recorded under `key` is not performed again: the recorded result is returned.
   *
   * @throws TaskCancelledError when the task is cancelled.
   * @throws TurnInterruptedError inside {@link StepRunner.interruptible} when an
   *   interrupting inbox item arrives.
   */
  step<N extends StepName>(name: N, key: StepKey, input: StepInput<N>): Promise<StepOutput<N>>;
  /**
   * Waits for the next inbox item nobody has taken yet.
   *
   * @throws TaskCancelledError when the task is cancelled while waiting.
   */
  nextInboxItem(): Promise<InboxItemRef>;
  /** Takes the items that arrived since the last call, without waiting for one. */
  drainInbox(): Promise<readonly InboxItemRef[]>;
  /** Runs `body` so that an interrupting inbox item aborts it. */
  interruptible<T>(body: () => Promise<T>): Promise<T>;
  /** Runs `body` shielded from cancellation — for recording the final status. */
  shielded<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Called each time the task goes idle, with where the run stands. A runner whose
   * history is bounded uses it to start afresh from this point; it then never returns.
   */
  checkpoint?(position: RunPosition): Promise<void>;
}

/** Where a run stands between turns: enough to continue it in a fresh run. */
export interface RunPosition {
  /** How many steps the run has numbered so far. */
  readonly sequence: number;
  /** Input plus output tokens used so far. */
  readonly tokens: number;
}

/** The task was cancelled. */
export class TaskCancelledError extends YaahError {
  constructor() {
    super('task.cancelled', 'task cancelled');
  }
}

/** An interrupting inbox item arrived; the current iteration was abandoned. */
export class TurnInterruptedError extends YaahError {
  constructor() {
    super('task.interrupted', 'turn interrupted');
  }
}

/** A run limit was reached. */
export class LimitError extends YaahError {
  readonly limit: 'iterations' | 'tokens';

  constructor(limit: 'iterations' | 'tokens', value: number) {
    super(`limit.${limit}`, `${limit} limit reached (${String(value)})`);
    this.limit = limit;
  }
}

/**
 * The process is shutting down: the run stops where it is and records nothing. It is
 * picked up again, from its journal, when the harness next starts.
 */
export class RunAbandonedError extends YaahError {
  constructor() {
    super('task.abandoned', 'run abandoned');
  }
}
