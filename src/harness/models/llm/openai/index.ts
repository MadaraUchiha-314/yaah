/**
 * The OpenAI plugin: registers one `llm` entity, `openai/<model>`, for every model id in
 * `providers.openai.models`.
 *
 * The API key is read once, at start, from the environment variable the configuration
 * names, and handed to the redactor. Without a key the plugin fails closed: it registers
 * nothing, and refuses to start when the default model is an OpenAI one.
 */
import type { Context } from 'cordis';

import { readCredential } from '../../../../kernel/credentials.ts';
import { ConfigError } from '../../../../kernel/errors.ts';
import { registerEntity } from '../../../../kernel/registry.ts';
import { t } from '../../../../kernel/strings.ts';
import type { FetchLike } from './content.ts';
import { createOpenAiLlm } from './provider.ts';
import { OPENAI } from './request.ts';

export { OPENAI_BASE_URL, createOpenAiLlm, openAiCapabilities } from './provider.ts';
export type { OpenAiLlmOptions } from './provider.ts';
export type { FetchLike } from './content.ts';

/** Configuration of the OpenAI plugin. Both fields exist for tests and embedders. */
export interface OpenAiPluginConfig {
  /** Used instead of the environment variable named by `providers.openai.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the global `fetch` for every model of this provider. */
  readonly fetch?: FetchLike | undefined;
}

export const name = 'llm-openai';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** The configuration key that names the credential's environment variable. */
const KEY_SETTING = 'providers.openai.api_key_env';
/** The file an operator fixes a credential setting in. */
export const CONFIG_FILE = 'config.toml';

/**
 * The error for a credential whose environment variable is not set.
 *
 * @param key The dotted configuration key that names the variable.
 */
export function credentialError(variable: string, key: string): ConfigError {
  const message = t('error.config.credential', { variable, key, file: CONFIG_FILE });
  return new ConfigError('config.credential', message, CONFIG_FILE, key);
}

/**
 * Starts the OpenAI provider.
 *
 * @throws ConfigError (`config.credential`) when no key is available and `model.llm`
 *   names an OpenAI model. When another provider is the default, a missing key only means
 *   no OpenAI model is registered.
 */
export function apply(ctx: Context, config: OpenAiPluginConfig | undefined): void {
  const settings = ctx.config.providers.openai;
  const apiKey = config?.apiKey ?? readCredential(ctx, settings.apiKeyEnv) ?? '';
  if (apiKey === '') {
    if (ctx.config.model.llm.startsWith(`${OPENAI}/`)) {
      throw credentialError(settings.apiKeyEnv, KEY_SETTING);
    }
    return;
  }
  ctx.redactor.add(apiKey);
  for (const model of settings.models) {
    registerEntity(
      ctx,
      createOpenAiLlm({ model, apiKey, baseUrl: settings.baseUrl, fetch: config?.fetch }),
    );
  }
}
