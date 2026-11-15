/**
 * What every core plugin does once it has a persistence backend: provide the
 * `persistence` service and register yaah's built-in tools. The Node plugin
 * (`./index.ts`) opens SQLite or the in-memory stores; the browser build's plugin has the
 * in-memory stores only, and loads no file system or database module.
 */
import type { Context } from 'cordis';

import { registerEntity } from '../../kernel/registry.ts';
import { createBuiltinTools } from './builtin-tools.ts';
import { createMemoryPersistence } from './memory-persistence.ts';
import type { Persistence } from './persistence.ts';
import type { SqlDatabase } from './sql.ts';

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

/** An open persistence backend and how to close it. */
export interface PersistenceBackend {
  readonly service: PersistenceService;
  close(): void;
}

/** The in-memory backend: nothing survives the process, or the tab. */
export function memoryBackend(): PersistenceBackend {
  return { service: { ...createMemoryPersistence(), database: null }, close: () => undefined };
}

/** Provides `backend` as the persistence service and registers the built-in tools. */
export function startCore(ctx: Context, backend: PersistenceBackend): void {
  ctx.effect(() => {
    const release = ctx.provide('persistence', backend.service);
    return (): void => {
      release();
      backend.close();
    };
  });
  for (const tool of createBuiltinTools(backend.service)) {
    registerEntity(ctx, tool);
  }
}
