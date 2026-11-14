/**
 * What the workflow and the rest of the harness agree on: names and payload shapes. This
 * file is imported by the workflow bundle, so it holds types and constants only.
 */
import type {
  InboxItemRef,
  RetryPolicy,
  RunLimits,
  RunPosition,
  StepName,
} from '../../../harness/core/step-runner.ts';
import type { Json } from '../../../kernel/json.ts';

/** The name of the workflow type that runs one task. */
export const TASK_WORKFLOW = 'taskWorkflow';
/** Signal: an inbox item was accepted for the task. */
export const INBOX_SIGNAL = 'inboxItem';
/** Signal: the task was cancelled. */
export const CANCEL_SIGNAL = 'cancelTask';

/** The workflow id of a task. */
export function workflowIdOf(taskId: string): string {
  return `yaah-${taskId}`;
}

/** What a task workflow is started with. */
export interface TaskWorkflowInput {
  readonly taskId: string;
  readonly limits: RunLimits;
  readonly retry: RetryPolicy;
  /** Set when this run continues an earlier one of the same task. */
  readonly resume?: {
    readonly position: RunPosition;
    /** Items signalled to the earlier run and not yet read. */
    readonly queued: readonly InboxItemRef[];
    /** Ids of every item already handed to the loop. */
    readonly seen: readonly string[];
  };
}

/** The one activity through which every step is performed. */
export interface StepActivityInput {
  readonly name: StepName;
  readonly taskId: string;
  readonly key: string;
  readonly input: Json;
  readonly outcomeUnknown: boolean;
}

/** The activities the workflow calls. */
export interface TaskActivities {
  /** Performs one step and returns its (small, JSON) output. */
  readonly performStep: (request: StepActivityInput) => Promise<Json>;
  /** Whether a step may be attempted again after a failure or an unknown outcome. */
  readonly isRetrySafe: (request: {
    readonly name: StepName;
    readonly input: Json;
  }) => Promise<boolean>;
}

/** The failure type of an error that trying again cannot fix. */
export const NON_RETRYABLE = 'YaahNonRetryable';
