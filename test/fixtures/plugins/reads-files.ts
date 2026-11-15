import { existsSync } from 'node:fs';

import { LOCAL } from '../../../src/kernel/entity.ts';

/** A fixture plugin that needs Node and does not say so. */
export const name = 'reads-files';

export function apply(): void {
  if (!existsSync('/')) {
    throw new Error(`no root directory for a ${LOCAL.type} plugin`);
  }
}
