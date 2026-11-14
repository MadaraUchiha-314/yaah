/**
 * The OpenAI System One plugin: registers one `system-one` entity,
 * `openai/<providers.openai.system_one_model>`, on OpenAI's Decisions API.
 *
 * The API key is the OpenAI provider's: read once, at start, from the environment
 * variable `providers.openai.api_key_env` names, and handed to the redactor. Without a
 * key the plugin fails closed: it registers nothing and says so with a
 * `system-one/unavailable` event, and refuses to start when inbox triage is set to use
 * this model.
 */
import type { Context } from 'cordis';

import { registerEntity } from '../../../../kernel/registry.ts';
import type { FetchLike } from '../../llm/openai/content.ts';
import { credentialError } from '../../llm/openai/index.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import { createOpenAiSystemOne } from './provider.ts';

export { OPENAI_SYSTEM_ONE_MODEL, createOpenAiSystemOne } from './provider.ts';
export type { OpenAiSystemOneOptions } from './provider.ts';

declare module 'cordis' {
  interface Events {
    /**
     * A System One model was not registered because the environment variable `variable`,
     * which holds its credential, is not set. Emitted once the harness is ready.
     */
    'system-one/unavailable'(id: string, variable: string): void;
  }
}

/** Configuration of the OpenAI System One plugin. Both fields exist for tests and embedders. */
export interface OpenAiSystemOnePluginConfig {
  /** Used instead of the environment variable named by `providers.openai.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

export const name = 'system-one-openai';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** The configuration key that names the credential's environment variable. */
const KEY_SETTING = 'providers.openai.api_key_env';

/**
 * Starts the OpenAI System One model.
 *
 * @throws ConfigError (`config.credential`) when no key is available and
 *   `inbox.triage = "system-one"` uses this model. Otherwise a missing key only means the
 *   model is not registered.
 */
export function apply(ctx: Context, config: OpenAiSystemOnePluginConfig | undefined): void {
  const settings = ctx.config.providers.openai;
  const id = `${OPENAI}/${settings.systemOneModel}`;
  const apiKey = config?.apiKey ?? process.env[settings.apiKeyEnv] ?? '';
  if (apiKey === '') {
    const { triage, triageModel } = ctx.config.inbox;
    if (triage === 'system-one' && triageModel === id) {
      throw credentialError(settings.apiKeyEnv, KEY_SETTING);
    }
    ctx.on('harness/ready', async () => {
      await Promise.resolve();
      ctx.emit('system-one/unavailable', id, settings.apiKeyEnv);
    });
    return;
  }
  ctx.redactor.add(apiKey);
  registerEntity(
    ctx,
    createOpenAiSystemOne({
      model: settings.systemOneModel,
      apiKey,
      baseUrl: settings.baseUrl,
      fetch: config?.fetch,
    }),
  );
}
