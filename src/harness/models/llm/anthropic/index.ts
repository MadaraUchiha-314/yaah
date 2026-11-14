/**
 * The Anthropic plugin: registers one `llm` entity per model id listed under
 * `[providers.anthropic]`, as `anthropic/<model>`.
 *
 * Fail closed: without the API key the plugin registers nothing — and refuses to start
 * when the configured model is one of its own.
 */
import type { Context } from 'cordis';

import { ConfigError } from '../../../../kernel/errors.ts';
import { registerEntity } from '../../../../kernel/registry.ts';
import { t } from '../../../../kernel/strings.ts';
import type { AnthropicFetch } from './provider.ts';
import { createAnthropicLlm } from './provider.ts';
import { PROVIDER } from './request.ts';

export { ANTHROPIC_URL, anthropicCapabilities, createAnthropicLlm } from './provider.ts';
export type { AnthropicFetch, AnthropicLlmOptions } from './provider.ts';

/** Configuration of the Anthropic plugin. Both fields exist for tests and embedders. */
export interface AnthropicPluginConfig {
  /** Used instead of the environment variable named by `providers.anthropic.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the global `fetch` for every model this plugin registers. */
  readonly fetch?: AnthropicFetch | undefined;
}

export const name = 'anthropic';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

const CONFIG_FILE = 'config.toml';
const KEY_SETTING = 'providers.anthropic.api_key_env';

/**
 * Registers the configured Claude models and hands the API key to the redactor.
 *
 * @throws ConfigError `config.credential` when the key's environment variable is not set
 *   and `model.llm` names an `anthropic/…` model. With any other model it registers
 *   nothing instead.
 */
export function apply(ctx: Context, config: AnthropicPluginConfig | undefined): void {
  const { apiKeyEnv, models } = ctx.config.providers.anthropic;
  const apiKey = config?.apiKey ?? process.env[apiKeyEnv] ?? '';
  if (apiKey === '') {
    if (ctx.config.model.llm.startsWith(`${PROVIDER}/`)) {
      throw new ConfigError(
        'config.credential',
        t('error.config.credential', { variable: apiKeyEnv, key: KEY_SETTING, file: CONFIG_FILE }),
        CONFIG_FILE,
        KEY_SETTING,
      );
    }
    return;
  }
  ctx.redactor.add(apiKey);
  for (const model of models) {
    registerEntity(ctx, createAnthropicLlm({ model, apiKey, fetch: config?.fetch }));
  }
}
