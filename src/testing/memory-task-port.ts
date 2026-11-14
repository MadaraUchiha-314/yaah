import type { TaskPort, TaskSnapshot, TaskStatusUpdate } from '../harness/core/task-port.ts';
import type { ContentPart, StepKey, TaskId, TaskModel } from '../harness/core/types.ts';

/** What a test may set when creating a task. */
export interface MemoryTaskInit {
  readonly taskId: TaskId;
  readonly longRunning?: boolean;
  readonly model?: Partial<TaskModel>;
  readonly llm?: string;
  readonly effort?: string;
}

/** A blank task model. */
export function blankTaskModel(overrides: Partial<TaskModel> = {}): TaskModel {
  return {
    name: 'Task',
    goal: '',
    description: '',
    acceptanceCriteria: [],
    subTasks: [],
    parentTasks: [],
    participants: [],
    depth: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

/** An in-memory {@link TaskPort} that remembers every status it was given. */
export class MemoryTaskPort implements TaskPort {
  /** Every status update, in the order applied. */
  readonly history: (TaskStatusUpdate & { readonly taskId: TaskId })[] = [];
  /** Model output stored per step, by `<taskId>/<stepKey>`. */
  readonly replies: Map<string, readonly ContentPart[]> = new Map();
  readonly #tasks = new Map<TaskId, TaskSnapshot>();
  readonly #applied = new Set<StepKey>();

  /** Creates a task in the `working` state. */
  create(init: MemoryTaskInit): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      taskId: init.taskId,
      contextId: `ctx-${init.taskId}`,
      longRunning: init.longRunning ?? false,
      model: blankTaskModel(init.model),
      state: 'working',
      subState: null,
      llm: init.llm ?? null,
      effort: init.effort ?? null,
    };
    this.#tasks.set(init.taskId, snapshot);
    return snapshot;
  }

  load(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = this.#tasks.get(taskId);
    return snapshot === undefined
      ? Promise.reject(new Error(`no task ${taskId}`))
      : Promise.resolve(snapshot);
  }

  async setStatus(taskId: TaskId, key: StepKey, update: TaskStatusUpdate): Promise<void> {
    if (this.#applied.has(key)) {
      return;
    }
    this.#applied.add(key);
    const snapshot = await this.load(taskId);
    this.#tasks.set(taskId, { ...snapshot, state: update.state, subState: update.subState });
    this.history.push({ ...update, taskId });
  }

  setReply(taskId: TaskId, key: StepKey, parts: readonly ContentPart[]): Promise<void> {
    this.replies.set(`${taskId}/${key}`, parts);
    return Promise.resolve();
  }

  async setModel(taskId: TaskId, key: StepKey, model: TaskModel): Promise<void> {
    if (this.#applied.has(key)) {
      return;
    }
    this.#applied.add(key);
    this.#tasks.set(taskId, { ...(await this.load(taskId)), model });
  }

  /** Changes the model or effort chosen for a task, as `/model` and `/effort` do. */
  async select(taskId: TaskId, choice: { llm?: string; effort?: string }): Promise<void> {
    this.#tasks.set(taskId, { ...(await this.load(taskId)), ...choice });
  }
}
