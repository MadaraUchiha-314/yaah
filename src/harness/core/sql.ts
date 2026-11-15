/**
 * The SQL surface the stores are written against, and nothing that opens a database: a
 * build without SQLite (the browser) can load this module.
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
