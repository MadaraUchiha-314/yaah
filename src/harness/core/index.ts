/**
 * The core plugin: opens the persistence backend and registers yaah's built-in tools.
 * Provides the `persistence` service.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Context } from 'cordis';

import { registerEntity } from '../../kernel/registry.ts';
import { createBuiltinTools } from './builtin-tools.ts';
import { createMemoryPersistence } from './memory-persistence.ts';
import type { Persistence } from './persistence.ts';
import type { SqlDatabase } from './sqlite-driver.ts';
import { openSqlitePersistence } from './sqlite-persistence.ts';

/** The persistence service: the five stores, and the database they share when there is one. */
export interface PersistenceService extends Persistence {
  /** The SQLite database, or null for the in-memory backend. */
  readonly database: SqlDatabase | null;
}

declare module 'cordis' {
  interface Context {
    /** The core's stores. Replace by providing this service from another plugin. */
    persistence: PersistenceService;
  }
}

/** `data_dir` value that selects the in-memory backend. */
export const MEMORY = ':memory:';

export const name = 'core';
export const inject: readonly string[] = ['entities', 'config'];

function open(dataDir: string): { service: PersistenceService; close: () => void } {
  if (dataDir === MEMORY) {
    return { service: { ...createMemoryPersistence(), database: null }, close: () => undefined };
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

/** Starts the core. */
export function apply(ctx: Context): void {
  const { service, close } = open(ctx.config.dataDir);
  ctx.effect(() => {
    const release = ctx.provide('persistence', service);
    return (): void => {
      release();
      close();
    };
  });
  for (const tool of createBuiltinTools(service)) {
    registerEntity(ctx, tool);
  }
}
