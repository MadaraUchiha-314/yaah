/**
 * The logger: one JSON object per line, the same in development and in production.
 * Every record passes through the redactor before it is written.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Json, JsonObject } from '../../kernel/json.ts';
import type { Redactor } from '../../kernel/redactor.ts';

/** How much is written. A record below the configured level is dropped. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The record types. The list is fixed: a consumer can rely on it. */
export type RecordType =
  | 'request.received'
  | 'inbox.accepted'
  | 'inbox.discarded'
  | 'context.built'
  | 'context.compacted'
  | 'llm.invoked'
  | 'tool.invoked'
  | 'agent.invoked'
  | 'state.written'
  | 'task.transition'
  | 'command.invoked'
  | 'command.executed'
  | 'command.failed'
  | 'task.stalled'
  | 'heartbeat.tick'
  | 'harness.event';

/** What a record carries besides its type. Undefined values are left out. */
export interface LogFields {
  readonly taskId?: string | undefined;
  readonly contextId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly stepName?: string | undefined;
  readonly [field: string]: Json | undefined;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Options of {@link Logger}. */
export interface LoggerOptions {
  readonly level: LogLevel;
  readonly redactor: Redactor;
  /** Receives each line, newline included. */
  readonly write: (line: string) => void;
  readonly now?: (() => Date) | undefined;
}

/** Writes structured records. */
export class Logger {
  readonly #options: LoggerOptions;

  constructor(options: LoggerOptions) {
    this.#options = options;
  }

  /** Writes one record, unless `level` is below the configured level. */
  record(type: RecordType, fields: LogFields = {}, level: LogLevel = 'info'): void {
    if (RANK[level] < RANK[this.#options.level]) {
      return;
    }
    const body: Record<string, Json> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value !== undefined) {
        body[field] = value;
      }
    }
    const time = (this.#options.now?.() ?? new Date()).toISOString();
    const redacted = this.#options.redactor.redact(body);
    const record = { time, level, type, ...(isPlainObject(redacted) ? redacted : {}) };
    this.#options.write(`${JSON.stringify(record)}\n`);
  }
}

function isPlainObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A writer appending to `path`, created (with its directory) readable by the owner only. */
export function fileWriter(path: string): (line: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (line: string): void => {
    appendFileSync(path, line, { mode: 0o600 });
  };
}

/** A writer to standard error. */
export function stderrWriter(line: string): void {
  process.stderr.write(line);
}
