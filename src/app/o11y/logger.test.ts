import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { Redactor } from '../../kernel/redactor.ts';
import { Logger, fileWriter, stderrWriter } from './logger.ts';

const NOW = (): Date => new Date('2026-01-02T03:04:05.000Z');

describe('Logger', () => {
  test('writes one JSON line per record, with undefined fields left out', () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: 'info',
      redactor: new Redactor(),
      write: (line) => {
        lines.push(line);
      },
      now: NOW,
    });
    logger.record('llm.invoked', { taskId: 't1', traceId: undefined, inputTokens: 4 });
    expect(lines).toEqual([
      '{"time":"2026-01-02T03:04:05.000Z","level":"info","type":"llm.invoked","taskId":"t1","inputTokens":4}\n',
    ]);
  });

  test('drops records below the configured level', () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: 'warn',
      redactor: new Redactor(),
      write: (line) => {
        lines.push(line);
      },
    });
    logger.record('tool.invoked', {}, 'debug');
    logger.record('tool.invoked');
    logger.record('tool.invoked', {}, 'error');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"level":"error"');
  });

  test('a secret never reaches the line, as a value or inside a message', () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: 'debug',
      redactor: new Redactor(['sk-secret-123456']),
      write: (line) => {
        lines.push(line);
      },
    });
    logger.record('tool.invoked', {
      error: 'failed using sk-secret-123456',
      apiKey: 'anything at all',
    });
    expect(lines[0]).not.toContain('sk-secret-123456');
    expect(lines[0]).not.toContain('anything at all');
    expect(lines[0]).toContain('[redacted]');
  });

  test('the file writer appends to a file only its owner can read', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yaah-log-')), 'logs', 'yaah.log');
    const write = fileWriter(path);
    write('one\n');
    write('two\n');
    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n');
    expect(statSync(path).mode % 0o1000).toBe(0o600);
  });

  test('the stderr writer writes to standard error', () => {
    const original = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      seen.push(String(chunk));
      return true;
    };
    try {
      stderrWriter('line\n');
    } finally {
      process.stderr.write = original;
    }
    expect(seen).toEqual(['line\n']);
  });
});
