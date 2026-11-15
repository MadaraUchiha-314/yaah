/**
 * Task storage. yaah keeps the A2A task in the SDK's own shape and encoding, behind the
 * SDK's `TaskStore` interface plus one addition the core needs: an **atomic update**.
 *
 * Two parties write tasks — the SDK's request handler and the core loop. Each reads a
 * task, changes it and saves it, and those sequences interleave. So the core is made the
 * only authority on status, artifacts and metadata ({@link YaahTaskStore.update}), and
 * what the request handler saves is merged in instead of written over
 * ({@link handlerFacing}).
 */
import type { ListTasksRequest, ListTasksResponse, Message, Task } from '@a2a-js/sdk';
import { Task as TaskCodec, TaskState } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';

import type { SqlDatabase } from '../../harness/core/sql.ts';
import { transaction } from '../../harness/core/sql.ts';
import { publicTask } from './task-port.ts';

/** A `TaskStore` with the atomic operations yaah needs. */
export interface YaahTaskStore extends TaskStore {
  /**
   * Reads the task, applies `change` and saves the result, as one indivisible operation.
   * `change` receives undefined when the task does not exist and may return undefined to
   * leave things as they are.
   */
  update(taskId: string, change: (task: Task | undefined) => Task | undefined): Task | undefined;
  /** The task as stored right now, or undefined. */
  get(taskId: string): Task | undefined;
  /** Every task that is not in a terminal state — what a restart must pick up again. */
  open(): Task[];
}

const TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const DEFAULT_PAGE_SIZE = 50;

function listFrom(all: readonly Task[], params: ListTasksRequest): ListTasksResponse {
  const after = params.statusTimestampAfter ?? '';
  const matching = all
    .filter(
      (task: Task) =>
        (params.contextId === '' || task.contextId === params.contextId) &&
        (params.status === TaskState.TASK_STATE_UNSPECIFIED ||
          task.status?.state === params.status) &&
        (after === '' || (task.status?.timestamp ?? '') > after),
    )
    .toSorted((a: Task, b: Task) =>
      (b.status?.timestamp ?? '').localeCompare(a.status?.timestamp ?? ''),
    );
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = params.pageToken === '' ? 0 : Number(params.pageToken);
  const next = offset + pageSize;
  return {
    tasks: matching.slice(offset, next).map((task: Task) => ({
      ...task,
      history:
        params.historyLength === undefined
          ? task.history
          : task.history.slice(Math.max(0, task.history.length - params.historyLength)),
      artifacts: params.includeArtifacts === true ? task.artifacts : [],
    })),
    nextPageToken: next < matching.length ? String(next) : '',
    pageSize,
    totalSize: matching.length,
  };
}

function isOpen(task: Task): boolean {
  return task.status === undefined || !TERMINAL.has(task.status.state);
}

/** An in-memory task store: tests and the browser build. */
export class MemoryTaskStore implements YaahTaskStore {
  readonly #tasks = new Map<string, Task>();

  save(task: Task): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
    return Promise.resolve();
  }

  get(taskId: string): Task | undefined {
    const task = this.#tasks.get(taskId);
    return task === undefined ? undefined : structuredClone(task);
  }

  load(taskId: string): Promise<Task | undefined> {
    return Promise.resolve(this.get(taskId));
  }

  list(params: ListTasksRequest): Promise<ListTasksResponse> {
    return Promise.resolve(structuredClone(listFrom([...this.#tasks.values()], params)));
  }

  update(taskId: string, change: (task: Task | undefined) => Task | undefined): Task | undefined {
    const current = this.#tasks.get(taskId);
    const next = change(current === undefined ? undefined : structuredClone(current));
    if (next !== undefined) {
      this.#tasks.set(taskId, structuredClone(next));
    }
    return next;
  }

  open(): Task[] {
    return structuredClone([...this.#tasks.values()].filter((task: Task) => isOpen(task)));
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_tasks (id TEXT PRIMARY KEY, task TEXT NOT NULL);
`;

function decode(row: unknown): Task {
  const fields: Readonly<Record<string, unknown>> =
    typeof row === 'object' && row !== null ? { ...row } : {};
  const source = fields['task'];
  const parsed: unknown = JSON.parse(typeof source === 'string' ? source : '{}');
  return TaskCodec.fromJSON(parsed);
}

/** A task store over SQLite, sharing the database file of the core's stores. */
export class SqliteTaskStore implements YaahTaskStore {
  readonly #database: SqlDatabase;

  constructor(database: SqlDatabase) {
    this.#database = database;
    database.exec(SCHEMA);
  }

  save(task: Task): Promise<void> {
    this.#write(task);
    return Promise.resolve();
  }

  get(taskId: string): Task | undefined {
    return this.#read(taskId);
  }

  load(taskId: string): Promise<Task | undefined> {
    return Promise.resolve(this.#read(taskId));
  }

  list(params: ListTasksRequest): Promise<ListTasksResponse> {
    return Promise.resolve(listFrom(this.#all(), params));
  }

  update(taskId: string, change: (task: Task | undefined) => Task | undefined): Task | undefined {
    return transaction(this.#database, () => {
      const next = change(this.#read(taskId));
      if (next !== undefined) {
        this.#write(next);
      }
      return next;
    });
  }

  open(): Task[] {
    return this.#all().filter((task: Task) => isOpen(task));
  }

  #all(): Task[] {
    const rows = this.#database.prepare('SELECT task FROM a2a_tasks').all();
    return rows.map((row: unknown) => decode(row));
  }

  #read(taskId: string): Task | undefined {
    const [row] = this.#database.prepare('SELECT task FROM a2a_tasks WHERE id = ?').all(taskId);
    return row === undefined ? undefined : decode(row);
  }

  #write(task: Task): void {
    this.#database
      .prepare(
        'INSERT INTO a2a_tasks (id, task) VALUES (?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET task = excluded.task',
      )
      .run(task.id, JSON.stringify(TaskCodec.toJSON(task)));
  }
}

function mergeHistory(ours: readonly Message[], theirs: readonly Message[]): Message[] {
  const known = new Set(ours.map((message: Message) => message.messageId));
  return [...ours, ...theirs.filter((message: Message) => !known.has(message.messageId))];
}

/**
 * The store handed to the SDK's request handler. A task the handler saves is created if
 * it is new; for an existing task only messages it adds to the history are kept. Status,
 * artifacts and metadata stay as the core last wrote them, so a save computed from a
 * stale read cannot undo a newer status. What the handler loads goes to callers, so it
 * comes without yaah's internal metadata.
 */
export function handlerFacing(store: YaahTaskStore): TaskStore {
  return {
    load: async (taskId: string, context: ServerCallContext): Promise<Task | undefined> => {
      const task = await store.load(taskId, context);
      return task === undefined ? undefined : publicTask(task);
    },
    list: async (params: ListTasksRequest, context: ServerCallContext) => {
      const listed = await store.list(params, context);
      return { ...listed, tasks: listed.tasks.map((task: Task) => publicTask(task)) };
    },
    save: (task: Task): Promise<void> => {
      store.update(task.id, (current: Task | undefined) =>
        current === undefined
          ? task
          : { ...current, history: mergeHistory(current.history, task.history) },
      );
      return Promise.resolve();
    },
  };
}
