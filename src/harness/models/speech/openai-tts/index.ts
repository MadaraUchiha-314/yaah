/**
 * The OpenAI text-to-speech plugin: registers one `text-to-speech` entity,
 * `openai/<providers.openai.tts_model>`, on OpenAI's Realtime API over a WebSocket.
 *
 * The API key is the OpenAI provider's: read once, at start, from the environment
 * variable `providers.openai.api_key_env` names, and handed to the redactor. Without a
 * key the plugin fails closed: it registers nothing and says so with a
 * `speech/unavailable` event, and refuses to start when `speech.tts` names this model.
 */
import type { Context } from 'cordis';

import { readCredential } from '../../../../kernel/credentials.ts';
import { registerEntity } from '../../../../kernel/registry.ts';
import { renderPrompt } from '../../../system-prompt/prompt.ts';
import { credentialError } from '../../llm/openai/index.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import type { RealtimeSocketFactory } from './provider.ts';
import { createOpenAiTextToSpeech } from './provider.ts';

export { OPENAI_TTS_MODEL, OPENAI_TTS_VOICE, createOpenAiTextToSpeech } from './provider.ts';
export type {
  OpenAiTextToSpeechOptions,
  RealtimeSocket,
  RealtimeSocketFactory,
} from './provider.ts';

/** Configuration of the plugin. Both fields exist for tests and embedders. */
export interface OpenAiTextToSpeechPluginConfig {
  /** Used instead of the environment variable named by `providers.openai.api_key_env`. */
  readonly apiKey?: string | undefined;
  /** Replaces the runtime's `WebSocket`. */
  readonly socket?: RealtimeSocketFactory | undefined;
}

export const name = 'speech-openai-tts';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** The configuration key that names the credential's environment variable. */
const KEY_SETTING = 'providers.openai.api_key_env';
/** The prompt that tells the Realtime model to read a text aloud instead of answering it. */
const PROMPT = 'speech';

/**
 * Starts the OpenAI text-to-speech model.
 *
 * @throws ConfigError (`config.credential`) when no key is available and `speech.tts`
 *   names this model. Otherwise a missing key only means the model is not registered.
 */
export function apply(ctx: Context, config: OpenAiTextToSpeechPluginConfig | undefined): void {
  const settings = ctx.config.providers.openai;
  const id = `${OPENAI}/${settings.ttsModel}`;
  const apiKey = config?.apiKey ?? readCredential(ctx, settings.apiKeyEnv) ?? '';
  if (apiKey === '') {
    if (ctx.config.speech.tts === id) {
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
    createOpenAiTextToSpeech({
      model: settings.ttsModel,
      voice: settings.ttsVoice,
      apiKey,
      baseUrl: settings.baseUrl,
      instructions: (): string => renderPrompt(ctx.entities, PROMPT, {}),
      socket: config?.socket,
    }),
  );
}
