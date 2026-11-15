/** The Node half of the SQLite shim. Loaded only on Node; Bun never imports this file. */
import { DatabaseSync } from 'node:sqlite';

import type { NativeDatabase } from './sqlite-driver.ts';

/** Opens a database with Node's built-in driver. */
export function openNodeDatabase(file: string): NativeDatabase {
  return new DatabaseSync(file);
}
