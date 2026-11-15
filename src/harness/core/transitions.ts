/**
 * The task-status table of the task-lifecycle extension, as a pure function. It is the
 * single place that decides whether a task stays open after an answer.
 */
import type { TaskState, TransitionRequest, TransitionResult } from './step-runner.ts';

/** The states a task never leaves. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'canceled',
  'failed',
]);

/** The transitions whose result does not depend on the task. */
const FIXED: Readonly<
  Record<Exclude<TransitionRequest['reason'], 'turn-complete'>, TransitionResult>
> = {
  'turn-start': { state: 'working', subState: null },
  'ask-user': { state: 'input-required', subState: 'awaiting-user-input' },
  'client-complete': { state: 'completed', subState: null },
  cancel: { state: 'canceled', subState: null },
  error: { state: 'failed', subState: null },
};

/** Whether a task in `state` can still receive messages. */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * The status a task moves to.
 *
 * | Request | Result |
 * | --- | --- |
 * | turn-start | working |
 * | turn-complete, long-running | input-required / awaiting-next-interaction |
 * | turn-complete, otherwise | completed |
 * | ask-user | input-required / awaiting-user-input |
 * | client-complete | completed |
 * | cancel | canceled |
 * | error | failed |
 *
 * @param longRunning Whether the task's creator asked to keep it open after each response.
 *   Only a root task can be long-running; a sub-task always completes on its answer.
 */
export function nextStatus(longRunning: boolean, request: TransitionRequest): TransitionResult {
  if (request.reason === 'turn-complete') {
    return longRunning
      ? { state: 'input-required', subState: 'awaiting-next-interaction' }
      : { state: 'completed', subState: null };
  }
  return FIXED[request.reason];
}
