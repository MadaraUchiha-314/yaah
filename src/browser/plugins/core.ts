/**
 * The browser build's core plugin: the same persistence service and built-in tools as the
 * Node plugin, on the in-memory stores — a tab has no SQLite and no directory to keep a
 * database in. Tasks last as long as the tab; `data_dir` has no effect.
 */
import type { Context } from 'cordis';

import { memoryBackend, startCore } from '../../harness/core/start.ts';

export const name = 'core';
export const inject: readonly string[] = ['entities', 'config'];

/** Starts the core on the in-memory stores. */
export function apply(ctx: Context): void {
  startCore(ctx, memoryBackend());
}
