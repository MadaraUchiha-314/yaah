/**
 * The SQLite persistence backend: the default of the `cli` and `server` builds. One file
 * holds the five stores; every multi-statement write is a transaction.
 */
import type { Json } from '../../kernel/json.ts';
import type {
  ConversationStore,
  InboxStore,
  Persistence,
  PlanStore,
  StateStore,
  StepJournal,
  StepRecord,
} from './persistence.ts';
import type { SqlDatabase } from './sqlite-driver.ts';
import { openDatabase, transaction } from './sqlite-driver.ts';
import type {
  ConversationEvent,
  ConversationEventBody,
  InboxItem,
  Plan,
  SeqRange,
  StepKey,
  TaskId,
} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, step_key TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX IF NOT EXISTS conversation_by_key ON conversation (task_id, step_key);
CREATE TABLE IF NOT EXISTS conversation_next (task_id TEXT PRIMARY KEY, next INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state (
  task_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (task_id, name)
);
CREATE TABLE IF NOT EXISTS applied (scope TEXT NOT NULL, step_key TEXT NOT NULL, PRIMARY KEY (scope, step_key));
CREATE TABLE IF NOT EXISTS plans (task_id TEXT PRIMARY KEY, plan TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox (
  position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  item TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS journal (
  position INTEGER PRIMARY KEY AUTOINCREMENT, step_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  result TEXT NOT NULL
);
`;

function column(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) {
    return undefined;
  }
  const fields: Readonly<Record<string, unknown>> = { ...row };
  return fields[name];
}

function text(row: unknown, name: string): string {
  const value = column(row, name);
  return typeof value === 'string' ? value : '';
}

function integer(row: unknown, name: string): number {
  const value = column(row, name);
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Reads back a value this module wrote. The cast is safe by construction: every column
 * decoded here was produced by `JSON.stringify` of the same type, a few lines away.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the type
function decode<T>(source: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the doc comment
  return JSON.parse(source) as T;
}

function toEvent(row: unknown): ConversationEvent {
  const body = decode<ConversationEventBody>(text(row, 'body'));
  return Object.assign(body, { seq: integer(row, 'seq'), key: text(row, 'step_key') });
}

function toItems(rows: readonly unknown[]): InboxItem[] {
  return rows.map((row: unknown) => decode<InboxItem>(text(row, 'item')));
}

function toRecord(row: unknown): StepRecord {
  return { key: text(row, 'step_key'), result: decode<Json>(text(row, 'result')) };
}

/** Applies `scope`/`key` once; returns false when it was applied before. */
function firstTime(database: SqlDatabase, scope: string, key: StepKey): boolean {
  const done = database
    .prepare('SELECT 1 AS hit FROM applied WHERE scope = ? AND step_key = ?')
    .all(scope, key);
  if (done.length > 0) {
    return false;
  }
  database.prepare('INSERT INTO applied (scope, step_key) VALUES (?, ?)').run(scope, key);
  return true;
}

function conversationStore(database: SqlDatabase): ConversationStore {
  return {
    put(taskId: TaskId, key: StepKey, events: readonly ConversationEventBody[]): Promise<void> {
      transaction(database, () => {
        const reusable = database
          .prepare('SELECT seq FROM conversation WHERE task_id = ? AND step_key = ? ORDER BY seq')
          .all(taskId, key)
          .map((row: unknown) => integer(row, 'seq'));
        database
          .prepare('DELETE FROM conversation WHERE task_id = ? AND step_key = ?')
          .run(taskId, key);
        const [counter] = database
          .prepare('SELECT next FROM conversation_next WHERE task_id = ?')
          .all(taskId);
        let next = counter === undefined ? 0 : integer(counter, 'next');
        const insert = database.prepare(
          'INSERT INTO conversation (task_id, seq, step_key, body) VALUES (?, ?, ?, ?)',
        );
        for (const [index, body] of events.entries()) {
          const reused = reusable[index];
          insert.run(taskId, reused ?? next, key, JSON.stringify(body));
          next += reused === undefined ? 1 : 0;
        }
        database
          .prepare(
            'INSERT INTO conversation_next (task_id, next) VALUES (?, ?) ' +
              'ON CONFLICT (task_id) DO UPDATE SET next = excluded.next',
          )
          .run(taskId, next);
      });
      return Promise.resolve();
    },
    read(taskId: TaskId, range?: SeqRange): Promise<readonly ConversationEvent[]> {
      const rows = database
        .prepare(
          'SELECT seq, step_key, body FROM conversation ' +
            'WHERE task_id = ? AND seq >= ? AND seq < ? ORDER BY seq',
        )
        .all(taskId, range?.from ?? 0, range?.to ?? Number.MAX_SAFE_INTEGER);
      return Promise.resolve(rows.map((row: unknown) => toEvent(row)));
    },
  };
}

function stateStore(database: SqlDatabase): StateStore {
  return {
    get(taskId: TaskId, name: string): Promise<Json | undefined> {
      const [row] = database
        .prepare('SELECT value FROM state WHERE task_id = ? AND name = ?')
        .all(taskId, name);
      return Promise.resolve(row === undefined ? undefined : decode<Json>(text(row, 'value')));
    },
    set(taskId: TaskId, key: StepKey, name: string, value: Json): Promise<void> {
      transaction(database, () => {
        if (firstTime(database, `state:${name}`, key)) {
          database
            .prepare(
              'INSERT INTO state (task_id, name, value) VALUES (?, ?, ?) ' +
                'ON CONFLICT (task_id, name) DO UPDATE SET value = excluded.value',
            )
            .run(taskId, name, JSON.stringify(value));
        }
      });
      return Promise.resolve();
    },
    names(taskId: TaskId): Promise<readonly string[]> {
      const rows = database
        .prepare('SELECT name FROM state WHERE task_id = ? ORDER BY name')
        .all(taskId);
      return Promise.resolve(rows.map((row: unknown) => text(row, 'name')));
    },
  };
}

function planStore(database: SqlDatabase): PlanStore {
  return {
    load(taskId: TaskId): Promise<Plan | undefined> {
      const [row] = database.prepare('SELECT plan FROM plans WHERE task_id = ?').all(taskId);
      return Promise.resolve(row === undefined ? undefined : decode<Plan>(text(row, 'plan')));
    },
    save(key: StepKey, plan: Plan): Promise<void> {
      transaction(database, () => {
        if (firstTime(database, 'plan', key)) {
          database
            .prepare(
              'INSERT INTO plans (task_id, plan) VALUES (?, ?) ' +
                'ON CONFLICT (task_id) DO UPDATE SET plan = excluded.plan',
            )
            .run(plan.taskId, JSON.stringify(plan));
        }
      });
      return Promise.resolve();
    },
  };
}

function inboxStore(database: SqlDatabase): InboxStore {
  return {
    put(item: InboxItem): Promise<'stored' | 'duplicate'> {
      const outcome = database
        .prepare('INSERT OR IGNORE INTO inbox (id, task_id, item) VALUES (?, ?, ?)')
        .run(item.id, item.taskId, JSON.stringify(item));
      return Promise.resolve(integer(outcome, 'changes') > 0 ? 'stored' : 'duplicate');
    },
    get(ids: readonly string[]): Promise<readonly InboxItem[]> {
      const select = database.prepare('SELECT item FROM inbox WHERE id = ?');
      return Promise.resolve(ids.flatMap((id: string) => toItems(select.all(id))));
    },
    pending(taskId?: TaskId): Promise<readonly InboxItem[]> {
      const rows =
        taskId === undefined
          ? database.prepare('SELECT item FROM inbox WHERE processed = 0 ORDER BY position').all()
          : database
              .prepare(
                'SELECT item FROM inbox WHERE processed = 0 AND task_id = ? ORDER BY position',
              )
              .all(taskId);
      return Promise.resolve(toItems(rows));
    },
    markProcessed(ids: readonly string[]): Promise<void> {
      const update = database.prepare('UPDATE inbox SET processed = 1 WHERE id = ?');
      transaction(database, () => {
        for (const id of ids) {
          update.run(id);
        }
      });
      return Promise.resolve();
    },
  };
}

function journalStore(database: SqlDatabase): StepJournal {
  return {
    get(key: StepKey): Promise<StepRecord | undefined> {
      const [row] = database
        .prepare('SELECT step_key, result FROM journal WHERE step_key = ?')
        .all(key);
      return Promise.resolve(row === undefined ? undefined : toRecord(row));
    },
    record(key: StepKey, result: Json): Promise<void> {
      database
        .prepare('INSERT OR IGNORE INTO journal (step_key, task_id, result) VALUES (?, ?, ?)')
        .run(key, key.split('/')[0] ?? '', JSON.stringify(result));
      return Promise.resolve();
    },
    list(taskId: TaskId): Promise<readonly StepRecord[]> {
      const rows = database
        .prepare('SELECT step_key, result FROM journal WHERE task_id = ? ORDER BY position')
        .all(taskId);
      return Promise.resolve(rows.map((row: unknown) => toRecord(row)));
    },
  };
}

/** A SQLite-backed {@link Persistence} that can be closed. */
export interface SqlitePersistence extends Persistence {
  /** The underlying database, for stores that share the file. */
  readonly database: SqlDatabase;
  close(): void;
}

/** Opens the backend at `file`, creating the file and its tables when missing. */
export function openSqlitePersistence(file: string): SqlitePersistence {
  const database = openDatabase(file);
  database.exec(SCHEMA);
  return {
    database,
    conversation: conversationStore(database),
    state: stateStore(database),
    plan: planStore(database),
    inbox: inboxStore(database),
    journal: journalStore(database),
    close: (): void => {
      database.close();
    },
  };
}
