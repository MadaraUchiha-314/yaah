/**
 * The browser build's system-prompt plugin: registers the prompts the build bundled, where
 * the Node plugin reads them from the `prompts/` directory. The entities are the same —
 * one `prompt` per markdown file, its id the file's base name.
 */
import type { Context } from 'cordis';

import { definePrompt } from '../../harness/system-prompt/prompt.ts';
import { registerEntity } from '../../kernel/registry.ts';

export const name = 'system-prompt';
export const inject: readonly string[] = ['entities', 'promptSources'];

/** Registers the bundled prompts. */
export function apply(ctx: Context): void {
  const ids = Object.keys(ctx.promptSources).toSorted();
  for (const id of ids) {
    registerEntity(ctx, definePrompt({ id, template: ctx.promptSources[id] ?? '' }));
  }
}
