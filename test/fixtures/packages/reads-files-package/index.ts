/**
 * A fixture plugin, named in a composition by its package name, that needs Node and does
 * not say so.
 */
import { existsSync } from 'node:fs';

export const name = 'reads-files-package';

export function apply(): void {
  if (!existsSync('/')) {
    throw new Error('no root directory');
  }
}
