/**
 * The core plugin: opens the persistence backend and registers yaah's built-in tools.
 * Provides the `persistence` service.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Context } from 'cordis';

import { openSqlitePersistence } from './sqlite-persistence.ts';
import type { PersistenceBackend } from './start.ts';
import { MEMORY, memoryBackend, startCore } from './start.ts';

export { MEMORY } from './start.ts';
export type { PersistenceService } from './start.ts';

export const name = 'core';
/** The runtimes this plugin runs on: it opens SQLite in a directory. */
export const runtime: readonly string[] = ['node'];
export const inject: readonly string[] = ['entities', 'config'];

function open(dataDir: string): PersistenceBackend {
  if (dataDir === MEMORY) {
    return memoryBackend();
  }
  const dir = dataDir === '' ? join(homedir(), '.yaah', 'data') : dataDir;
  mkdirSync(dir, { recursive: true });
  const backend = openSqlitePersistence(join(dir, 'yaah.db'));
  return {
    service: backend,
    close: (): void => {
      backend.close();
    },
  };
}

/** Starts the core on the backend the configuration selects. */
export function apply(ctx: Context): void {
  startCore(ctx, open(ctx.config.dataDir));
}
