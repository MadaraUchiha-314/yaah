/**
 * The core's {@link TaskPort} over the A2A task store: the A2A task is the task. Status
 * is written to the store first and published to the stream hub second, so the store is
 * always the record.
 */
import type { Task } from '@a2a-js/sdk';

import type { TaskPort, TaskSnapshot, TaskStatusUpdate } from '../../harness/core/task-port.ts';
import type { ContentPart, StepKey, TaskId, TaskModel } from '../../harness/core/types.ts';
import { YaahError } from '../../kernel/errors.ts';
import type { StreamHub } from '../stream-hub.ts';
import { fromA2aState, resultArtifact, toA2aStatus } from './convert.ts';
import type { YaahTaskStore } from './task-store.ts';
import { EXT, SCHEMAS, readExtension } from './extensions/index.ts';

/** Task metadata key for yaah's own per-task settings. Not an extension: never leaves yaah. */
export const SETTINGS_KEY = 'yaah.settings';

/** Task metadata key for the step that last set the status, which makes a repeat a no-op. */
export const STATUS_KEY = 'yaah.status-step';

/** Settings yaah keeps on a task. */
export interface TaskSettings {
  readonly longRunning: boolean;
  /** Who created the task: the caller key used for the per-caller limits. */
  readonly caller: string;
  /** The LLM entity id chosen with `/model`, or null. */
  readonly llm: string | null;
  /** The effort chosen with `/effort`, or null. */
  readonly effort: string | null;
}

const NO_SETTINGS: TaskSettings = { longRunning: false, caller: '', llm: null, effort: null };

/** A model for a task that carries none. */
export function emptyTaskModel(): TaskModel {
  return {
    name: '',
    goal: '',
    description: '',
    acceptanceCriteria: [],
    subTasks: [],
    parentTasks: [],
    participants: [],
    depth: 0,
    schemaVersion: 1,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads yaah's settings from a task's metadata. */
export function readSettings(task: Task): TaskSettings {
  const metadata: unknown = task.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return NO_SETTINGS;
  }
  const fields: Readonly<Record<string, unknown>> = { ...metadata };
  const raw = fields[SETTINGS_KEY];
  if (typeof raw !== 'object' || raw === null) {
    return NO_SETTINGS;
  }
  const settings: Readonly<Record<string, unknown>> = { ...raw };
  return {
    longRunning: settings['longRunning'] === true,
    caller: text(settings['caller']) ?? '',
    llm: text(settings['llm']),
    effort: text(settings['effort']),
  };
}

/** Reads the task model from a task's metadata; a task without one gets an empty model. */
export function readTaskModel(task: Task): TaskModel {
  return readExtension(task.metadata, EXT.taskModel, SCHEMAS.taskModel) ?? emptyTaskModel();
}

/** The task does not exist. */
export class UnknownTaskError extends YaahError {
  constructor(taskId: TaskId) {
    super('task.unknown', `no task ${taskId}`);
  }
}

/** The id of the artifact holding what the model said in step `key`. */
export function replyArtifactId(key: StepKey): string {
  return `response-${key}`;
}

/** A {@link TaskPort} backed by an A2A task store and a stream hub. */
export class A2aTaskPort implements TaskPort {
  readonly #store: YaahTaskStore;
  readonly #hub: StreamHub;

  constructor(store: YaahTaskStore, hub: StreamHub) {
    this.#store = store;
    this.#hub = hub;
  }

  load(taskId: TaskId): Promise<TaskSnapshot> {
    const task = this.#read(taskId);
    const settings = readSettings(task);
    const lifecycle = readExtension(
      task.status?.message?.metadata,
      EXT.taskLifecycle,
      SCHEMAS.taskLifecycleStatus,
    );
    const subState = lifecycle?.subState;
    return Promise.resolve({
      taskId,
      contextId: task.contextId,
      longRunning: settings.longRunning,
      model: readTaskModel(task),
      state: fromA2aState(task.status?.state),
      subState:
        subState === 'awaiting-next-interaction' || subState === 'awaiting-user-input'
          ? subState
          : null,
      llm: settings.llm,
      effort: settings.effort,
    });
  }

  setStatus(taskId: TaskId, key: StepKey, update: TaskStatusUpdate): Promise<void> {
    let applied = false;
    this.#change(taskId, (task: Task): Task | undefined => {
      const metadata: Readonly<Record<string, unknown>> = { ...task.metadata };
      if (metadata[STATUS_KEY] === key) {
        // This step already recorded its status: a repeat changes nothing.
        return undefined;
      }
      applied = true;
      const status = toA2aStatus({
        taskId,
        contextId: task.contextId,
        state: update.state,
        subState: update.subState,
        message: update.message,
        messageId: key,
        timestamp: new Date().toISOString(),
      });
      const history =
        status.message === undefined ? task.history : [...task.history, status.message];
      return { ...task, status, history, metadata: { ...task.metadata, [STATUS_KEY]: key } };
    });
    if (applied) {
      this.#hub.publish(taskId, {
        type: 'status',
        state: update.state,
        subState: update.subState,
        messageId: key,
      });
    }
    return Promise.resolve();
  }

  setReply(taskId: TaskId, key: StepKey, parts: readonly ContentPart[]): Promise<void> {
    const artifactId = replyArtifactId(key);
    this.#change(taskId, (task: Task): Task => ({
      ...task,
      artifacts: [
        ...task.artifacts.filter((artifact) => artifact.artifactId !== artifactId),
        resultArtifact(artifactId, parts),
      ],
    }));
    this.#hub.publish(taskId, { type: 'artifact', artifactId, parts });
    return Promise.resolve();
  }

  setModel(taskId: TaskId, _key: StepKey, model: TaskModel): Promise<void> {
    this.#change(taskId, (task: Task): Task => ({
      ...task,
      metadata: { ...task.metadata, [EXT.taskModel]: model },
    }));
    return Promise.resolve();
  }

  /** Changes yaah's settings on a task. */
  updateSettings(taskId: TaskId, change: Partial<TaskSettings>): void {
    this.#change(taskId, (task: Task): Task => ({
      ...task,
      metadata: { ...task.metadata, [SETTINGS_KEY]: { ...readSettings(task), ...change } },
    }));
  }

  #read(taskId: TaskId): Task {
    const task = this.#store.get(taskId);
    if (task === undefined) {
      throw new UnknownTaskError(taskId);
    }
    return task;
  }

  #change(taskId: TaskId, change: (task: Task) => Task | undefined): void {
    this.#store.update(taskId, (task: Task | undefined) => {
      if (task === undefined) {
        throw new UnknownTaskError(taskId);
      }
      return change(task);
    });
  }
}
