/**
 * The image plugin: registers the `generate_image` tool on OpenAI's image API, with the
 * model `providers.openai.image_model`.
 *
 * The API key is the OpenAI provider's: read once, at start, from the environment
 * variable `providers.openai.api_key_env` names, and handed to the redactor. Without a
 * key the plugin fails closed: the tool is not registered, so no model is offered it.
 */
import type { Context } from 'cordis';

import { registerEntity } from '../../../kernel/registry.ts';
import type { FetchLike } from '../../models/llm/openai/content.ts';
import { createGenerateImageTool } from './tool.ts';

export { GENERATE_IMAGE, OPENAI_IMAGE_MODEL, createGenerateImageTool } from './tool.ts';
export type { GenerateImageOptions } from './tool.ts';

/** Configuration of the plugin. Both fields exist for tests and embedders. */
export interface ImagePluginConfig {
  /** Used instead of the environment variable named by `providers.openai.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

export const name = 'tool-image-openai';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** Registers `generate_image` when a key is available. */
export function apply(ctx: Context, config: ImagePluginConfig | undefined): void {
  const settings = ctx.config.providers.openai;
  const apiKey = config?.apiKey ?? process.env[settings.apiKeyEnv] ?? '';
  if (apiKey === '') {
    return;
  }
  ctx.redactor.add(apiKey);
  registerEntity(
    ctx,
    createGenerateImageTool({
      model: settings.imageModel,
      apiKey,
      baseUrl: settings.baseUrl,
      fetch: config?.fetch,
    }),
  );
}
