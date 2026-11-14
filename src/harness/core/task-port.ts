/**
 * How the core reads and updates the task it is working on. The task itself lives where
 * the protocol layer keeps it — on the A2A task — so the core holds no task table of its
 * own; it sees the task through this port.
 */
import type { TaskState, TaskSubState } from './step-runner.ts';
import type { JsonObject } from '../../kernel/json.ts';
import type { ContentPart, StepKey, TaskId, TaskModel } from './types.ts';

/** The task as the core needs to see it. */
export interface TaskSnapshot {
  readonly taskId: TaskId;
  readonly contextId: string;
  /** Keep the task open after each response. Never true for a sub-task. */
  readonly longRunning: boolean;
  readonly model: TaskModel;
  readonly state: TaskState;
  readonly subState: TaskSubState | null;
  /** The LLM entity id chosen for this task's context, or null for the configured default. */
  readonly llm: string | null;
  /** The reasoning effort chosen for this task's context, or null for the default. */
  readonly effort: string | null;
  /**
   * The metadata of the latest message from the client. A turn extension reads what the
   * client offered for this turn from here (for example the UI catalogs it can render).
   */
  readonly turnMetadata: JsonObject;
}

/** Something the agent is doing right now, for the interfaces following the task. */
export interface Activity {
  readonly kind: 'tool';
  /** The model's id for the call. */
  readonly id: string;
  /** The tool's name. */
  readonly name: string;
  readonly phase: 'started' | 'finished';
  /** Set when finished. */
  readonly ok?: boolean | undefined;
  /** Set when finished: how long it took. */
  readonly durationMs?: number | undefined;
}

/** A new status for a task. */
export interface TaskStatusUpdate {
  readonly state: TaskState;
  readonly subState: TaskSubState | null;
  /** The answer, the question, or the reason — whatever the status is about. */
  readonly message: readonly ContentPart[];
}

/** The core's view of task storage. */
export interface TaskPort {
  /** @throws when the task does not exist. */
  load(taskId: TaskId): Promise<TaskSnapshot>;
  /** Records a status. Repeating the call with the same `key` has no further effect. */
  setStatus(taskId: TaskId, key: StepKey, update: TaskStatusUpdate): Promise<void>;
  /**
   * Stores what the model said in step `key` as an output of the task. Repeating the call
   * with the same `key` replaces the earlier content.
   */
  setReply(taskId: TaskId, key: StepKey, parts: readonly ContentPart[]): Promise<void>;
  /** Replaces the task model. Repeating the call with the same `key` has no further effect. */
  setModel(taskId: TaskId, key: StepKey, model: TaskModel): Promise<void>;
}

/** Where a running step sends what a client should see before the step finishes. */
export interface StreamSink {
  /** A piece of the model's answer, as it is produced by step `key`. */
  delta(taskId: TaskId, key: StepKey, text: string): void;
  /** Everything step `key` streamed so far is void: the step is being attempted again. */
  reset(taskId: TaskId, key: StepKey): void;
  /** The agent started or finished something worth showing. Never stored. */
  activity(taskId: TaskId, activity: Activity): void;
}

/** A sink that drops everything. */
export const NO_STREAM: StreamSink = {
  delta(): void {
    // Nothing is listening.
  },
  reset(): void {
    // Nothing is listening.
  },
  activity(): void {
    // Nothing is listening.
  },
};
