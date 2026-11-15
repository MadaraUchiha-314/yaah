/**
 * The OpenAI speech-to-text plugin: registers one `speech-to-text` entity,
 * `openai/<providers.openai.stt_model>`, on OpenAI's transcription API.
 *
 * The API key is the OpenAI provider's: read once, at start, from the environment
 * variable `providers.openai.api_key_env` names, and handed to the redactor. Without a
 * key the plugin fails closed: it registers nothing and says so with a
 * `speech/unavailable` event, and refuses to start when `speech.stt` names this model.
 */
import type { Context } from 'cordis';

import { registerEntity } from '../../../../kernel/registry.ts';
import type { FetchLike } from '../../llm/openai/content.ts';
import { credentialError } from '../../llm/openai/index.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import { createOpenAiSpeechToText } from './provider.ts';

export { OPENAI_STT_MODEL, createOpenAiSpeechToText } from './provider.ts';
export type { OpenAiSpeechToTextOptions } from './provider.ts';

declare module 'cordis' {
  interface Events {
    /**
     * A speech model was not registered because the environment variable `variable`,
     * which holds its credential, is not set. Emitted once the harness is ready.
     */
    'speech/unavailable'(id: string, variable: string): void;
  }
}

/** Configuration of the plugin. Both fields exist for tests and embedders. */
export interface OpenAiSpeechToTextPluginConfig {
  /** Used instead of the environment variable named by `providers.openai.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

export const name = 'speech-openai-stt';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** The configuration key that names the credential's environment variable. */
const KEY_SETTING = 'providers.openai.api_key_env';

/**
 * Starts the OpenAI speech-to-text model.
 *
 * @throws ConfigError (`config.credential`) when no key is available and `speech.stt`
 *   names this model. Otherwise a missing key only means the model is not registered.
 */
export function apply(ctx: Context, config: OpenAiSpeechToTextPluginConfig | undefined): void {
  const settings = ctx.config.providers.openai;
  const id = `${OPENAI}/${settings.sttModel}`;
  const apiKey = config?.apiKey ?? process.env[settings.apiKeyEnv] ?? '';
  if (apiKey === '') {
    if (ctx.config.speech.stt === id) {
      throw credentialError(settings.apiKeyEnv, KEY_SETTING);
    }
    ctx.on('harness/ready', async () => {
      await Promise.resolve();
      ctx.emit('speech/unavailable', id, settings.apiKeyEnv);
    });
    return;
  }
  ctx.redactor.add(apiKey);
  registerEntity(
    ctx,
    createOpenAiSpeechToText({
      model: settings.sttModel,
      apiKey,
      baseUrl: settings.baseUrl,
      fetch: config?.fetch,
    }),
  );
}
