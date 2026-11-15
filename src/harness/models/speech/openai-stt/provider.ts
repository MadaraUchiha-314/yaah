/**
 * The OpenAI speech-to-text provider: one `speech-to-text` entity on
 * `POST /v1/audio/transcriptions` of the official SDK, with `stream: true`, so the
 * transcript arrives as it is recognised.
 */
import OpenAI, { toFile } from 'openai';
import type { TranscriptionStreamEvent } from 'openai/resources/audio/transcriptions';

import { t } from '../../../../kernel/strings.ts';
import type { FetchLike } from '../../llm/openai/content.ts';
import type { ErrorScope } from '../../llm/openai/errors.ts';
import { OPENAI_BASE_URL } from '../../llm/openai/provider.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import { endedEarly, toSpeechError, unsupportedAudio } from '../openai-errors.ts';
import type { AudioInput, SpeechToText, TranscriptEvent } from '../types.ts';

/** The transcription model used unless the configuration names another. */
export const OPENAI_STT_MODEL = 'gpt-transcribe';

/** What {@link createOpenAiSpeechToText} needs. */
export interface OpenAiSpeechToTextOptions {
  /** The model id as OpenAI names it. Defaults to {@link OPENAI_STT_MODEL}. */
  readonly model?: string | undefined;
  /** The API key. Sent only as the bearer token; never logged or put in an error. */
  readonly apiKey: string;
  /** Defaults to OpenAI's own API. */
  readonly baseUrl?: string | undefined;
  /** Replaces the global `fetch`; tests use it to replay canned responses. */
  readonly fetch?: FetchLike | undefined;
}

/**
 * The file extension the API identifies each accepted format by. The upload is always
 * named `audio.<extension>` — never by a name a client sent.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
};

/** The media type without its parameters: `audio/webm;codecs=opus` is `audio/webm`. */
function baseType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

function eventOf(event: TranscriptionStreamEvent): TranscriptEvent | null {
  if (event.type === 'transcript.text.delta') {
    return { type: 'delta', text: event.delta };
  }
  return event.type === 'transcript.text.done' ? { type: 'done', text: event.text } : null;
}

async function* transcribe(
  client: OpenAI,
  scope: ErrorScope,
  audio: AudioInput,
  signal: AbortSignal,
): AsyncGenerator<TranscriptEvent> {
  try {
    signal.throwIfAborted();
    const type = baseType(audio.mediaType);
    const extension = EXTENSIONS[type];
    if (extension === undefined) {
      throw unsupportedAudio(scope, type);
    }
    const file = await toFile(audio.data, `audio.${extension}`, { type });
    const params = { file, model: scope.model, stream: true } as const;
    const stream = await client.audio.transcriptions.create(params, { signal });
    for await (const event of stream) {
      const mapped = eventOf(event);
      if (mapped !== null) {
        yield mapped;
        if (mapped.type === 'done') {
          return;
        }
      }
    }
    throw endedEarly(scope);
  } catch (error) {
    throw toSpeechError(scope, error, signal);
  }
}

/**
 * Creates the `speech-to-text` entity `openai/<model>`.
 *
 * The entity never retries: a failed call is one `SpeechError`, and its `retryable` flag
 * tells the caller whether to try again.
 */
export function createOpenAiSpeechToText(options: OpenAiSpeechToTextOptions): SpeechToText {
  const model = options.model ?? OPENAI_STT_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    // Ambient OPENAI_ORG_ID / OPENAI_PROJECT_ID must not change what a configured model does.
    organization: null,
    project: null,
    fetch: options.fetch,
  });
  const scope: ErrorScope = { provider: OPENAI, model, secrets: [options.apiKey] };
  return {
    ref: { kind: 'speech-to-text', id: `${OPENAI}/${model}`, version: null },
    description: t('speech.openai-stt.description', { model }),
    locality: { type: 'remote', protocol: 'https', url: baseUrl },
    transcribe: (audio: AudioInput, signal: AbortSignal): AsyncIterable<TranscriptEvent> =>
      transcribe(client, scope, audio, signal),
  };
}
