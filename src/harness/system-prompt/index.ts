/**
 * The system-prompt plugin: registers every markdown file under `prompts/` as a `prompt`
 * entity whose id is the file's base name. An operator overrides one by registering a
 * prompt with the same id and `override: true`, or extends it with `extends: <id>`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { Context } from 'cordis';

import { assetPath } from '../../kernel/assets.ts';
import { registerEntity } from '../../kernel/registry.ts';
import { definePrompt } from './prompt.ts';

export { definePrompt, renderPrompt } from './prompt.ts';
export type { Prompt, PromptDefinition } from './prompt.ts';

/** Configuration of the system-prompt plugin. */
export interface SystemPromptConfig {
  /** Directory of markdown prompts. Defaults to the prompts shipped with yaah. */
  readonly dir?: string;
}

export const name = 'system-prompt';
export const inject: readonly string[] = ['entities'];

/** Loads and registers the prompts. */
export async function apply(ctx: Context, config: SystemPromptConfig | undefined): Promise<void> {
  const dir = config?.dir ?? assetPath('prompts');
  const files = (await readdir(dir)).filter((file: string) => extname(file) === '.md').toSorted();
  const sources = await Promise.all(files.map((file: string) => readFile(join(dir, file), 'utf8')));
  for (const [index, file] of files.entries()) {
    registerEntity(
      ctx,
      definePrompt({ id: basename(file, '.md'), template: sources[index] ?? '' }),
    );
  }
}
