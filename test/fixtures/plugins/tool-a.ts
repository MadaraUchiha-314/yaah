import type { Context } from 'cordis';

import { definePrompt } from '../../../src/harness/system-prompt/prompt.ts';
import { registerEntity } from '../../../src/kernel/registry.ts';

/** A fixture plugin: registers one prompt whose text comes from its config. */
export const name = 'fixture-a';

export function apply(ctx: Context, config: { readonly text?: string }): void {
  registerEntity(ctx, definePrompt({ id: 'fixture', template: config.text ?? 'default A' }));
}
