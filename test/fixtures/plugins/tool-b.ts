import type { Context } from 'cordis';

import { definePrompt } from '../../../src/harness/system-prompt/prompt.ts';
import { registerEntity } from '../../../src/kernel/registry.ts';

/** A fixture plugin an operator swaps in for fixture-a. */
export const name = 'fixture-b';

export function apply(ctx: Context): void {
  registerEntity(ctx, definePrompt({ id: 'fixture', template: 'replacement B' }));
}
