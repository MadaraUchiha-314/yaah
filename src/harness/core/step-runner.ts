/**
 * The seam between the core loop and the world. The loop is deterministic computation
 * over a {@link StepRunner}; everything with an effect — a model call, a tool call, a
 * store write, a wait — is a step the runner performs. Two runners exist: one executes
 * steps in this process, the other is a Temporal workflow whose steps are activities.
 */
import { YaahError } from '../../kernel/errors.ts';
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
