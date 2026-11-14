/**
 * One SQLite interface over the two runtimes' built-in drivers: `bun:sqlite` on Bun and
 * `node:sqlite` on Node. Both are synchronous and share the small surface used here, so
 * yaah needs no SQLite dependency of its own.
 */

/** A prepared statement. */
export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/** An open database. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** A value that can be bound to a statement parameter. */
export type SqlValue = string | number | null;

type Open = (file: string) => SqlDatabase;

/** The part of both drivers' API used here. */
export interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  };
  close(): unknown;
}

function adapt(native: NativeDatabase): SqlDatabase {
  return {
    exec: (sql: string): void => {
      native.exec(sql);
    },
    prepare: (sql: string): SqlStatement => {
      const statement = native.prepare(sql);
      return {
        run: (...params: SqlValue[]): unknown => statement.run(...params),
        all: (...params: SqlValue[]): unknown[] => statement.all(...params),
      };
    },
    close: (): void => {
      native.close();
    },
  };
}

async function loadDriver(): Promise<Open> {
  if ('Bun' in globalThis) {
    const { Database } = await import('bun:sqlite');
    return (file: string): SqlDatabase => adapt(new Database(file, { create: true }));
  }
  const { openNodeDatabase } = await import('./sqlite-driver-node.ts');
  return (file: string): SqlDatabase => adapt(openNodeDatabase(file));
}

const open = await loadDriver();

/** Opens (creating if needed) the SQLite database at `file`. `:memory:` is accepted. */
export function openDatabase(file: string): SqlDatabase {
  const database = open(file);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return database;
}

/** Runs `body` in a transaction: all of its writes are applied, or none. */
export function transaction<T>(database: SqlDatabase, body: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
