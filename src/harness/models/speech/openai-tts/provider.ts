/**
 * The OpenAI text-to-speech provider: one `text-to-speech` entity on the Realtime API,
 * over a WebSocket. Each utterance is one short session: the session is told to answer
 * in audio only, the text is added as a user message, a response is requested, and the
 * `response.output_audio.delta` events that follow are the speech, as it is produced.
 *
 * The events sent are typed by the official SDK (`openai/resources/realtime/realtime`);
 * the socket itself is injected, so a test can stand in for the server.
 */
import type {
  ConversationItemCreateEvent,
  RealtimeClientEvent,
  ResponseCreateEvent,
  SessionUpdateEvent,
} from 'openai/resources/realtime/realtime';
import { z } from 'zod';

import type { AsyncQueue } from '../../../../kernel/async-queue.ts';
import { createAsyncQueue } from '../../../../kernel/async-queue.ts';
import { t } from '../../../../kernel/strings.ts';
import type { ErrorScope } from '../../llm/openai/errors.ts';
import { abortedError } from '../../llm/openai/errors.ts';
import { OPENAI_BASE_URL } from '../../llm/openai/provider.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import { endedEarly, reportedFailure, toSpeechError } from '../openai-errors.ts';
import type { AudioFormat, TextToSpeech } from '../types.ts';

/** The Realtime model used unless the configuration names another. */
export const OPENAI_TTS_MODEL = 'gpt-realtime-2.1-mini';
/** The voice used unless the configuration names another. */
export const OPENAI_TTS_VOICE = 'marin';

/** The one output format requested: 16-bit PCM, mono, at the only rate the API offers. */
const FORMAT: AudioFormat = { mediaType: 'audio/pcm', sampleRate: 24_000, channels: 1 };

/** The slice of a WebSocket this provider uses. The runtime's own `WebSocket` fits it. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
}

/** Opens a socket to `url`, sending `headers` with the handshake. */
export type RealtimeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => RealtimeSocket;

/** What {@link createOpenAiTextToSpeech} needs. */
export interface OpenAiTextToSpeechOptions {
  /** The model id as OpenAI names it. Defaults to {@link OPENAI_TTS_MODEL}. */
  readonly model?: string | undefined;
  /** One of the Realtime API's voices. Defaults to {@link OPENAI_TTS_VOICE}. */
  readonly voice?: string | undefined;
  /** The API key. Sent only as the bearer token of the handshake. */
  readonly apiKey: string;
  /** The HTTP base URL of the API; the socket address is derived from it. */
  readonly baseUrl?: string | undefined;
  /** The session instructions: the prompt that tells the model to read, not to answer. */
  readonly instructions: () => string;
  /** Replaces the runtime's `WebSocket`; tests use it to script the server. */
  readonly socket?: RealtimeSocketFactory | undefined;
}

/** The fields this provider reads from a server event; everything else is ignored. */
const serverEvent = z.object({
  type: z.string(),
  delta: z.string().optional(),
  error: z.object({ code: z.string().nullish(), type: z.string().optional() }).optional(),
  response: z
    .object({
      status: z.string().optional(),
      status_details: z
        .object({ error: z.object({ code: z.string().nullish() }).nullish() })
        .nullish(),
    })
    .optional(),
});

/** Opens the runtime's own WebSocket. Bun and Node both take handshake headers. */
function openSocket(url: string, headers: Readonly<Record<string, string>>): RealtimeSocket {
  return new WebSocket(url, { headers: { ...headers } });
}

/** `wss://api.openai.com/v1/realtime?model=<model>`, from the HTTP base URL. */
export function realtimeUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/realtime`;
  url.search = '';
  url.searchParams.set('model', model);
  return url.toString();
}

/** The three events that make the model say `text`: configure, add the text, respond. */
function utterance(text: string, voice: string, instructions: string): RealtimeClientEvent[] {
  const session: SessionUpdateEvent = {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions,
      output_modalities: ['audio'],
      audio: { output: { format: { type: 'audio/pcm', rate: 24_000 }, voice } },
    },
  };
  const item: ConversationItemCreateEvent = {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
  const respond: ResponseCreateEvent = { type: 'response.create' };
  return [session, item, respond];
}

function parse(data: unknown): z.infer<typeof serverEvent> | null {
  try {
    const parsed = serverEvent.safeParse(JSON.parse(typeof data === 'string' ? data : ''));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Feeds `queue` from one server event. Returns true when the utterance is over. */
function onEvent(scope: ErrorScope, queue: AsyncQueue<Uint8Array>, data: unknown): boolean {
  const event = parse(data);
  if (event === null) {
    return false;
  }
  if (event.type === 'response.output_audio.delta' && (event.delta ?? '') !== '') {
    queue.push(Uint8Array.from(Buffer.from(event.delta ?? '', 'base64')));
    return false;
  }
  if (event.type === 'error') {
    queue.fail(reportedFailure(scope, event.error?.code ?? event.error?.type));
    return true;
  }
  if (event.type !== 'response.done') {
    return false;
  }
  if (event.response?.status === 'completed' || event.response?.status === undefined) {
    queue.end();
  } else {
    queue.fail(reportedFailure(scope, event.response.status_details?.error?.code));
  }
  return true;
}

interface Speaker {
  readonly scope: ErrorScope;
  readonly url: string;
  readonly voice: string;
  readonly apiKey: string;
  readonly instructions: () => string;
  readonly open: RealtimeSocketFactory;
}

async function* speak(
  speaker: Speaker,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const { scope } = speaker;
  if (signal.aborted) {
    throw toSpeechError(scope, abortedError(scope), signal);
  }
  if (text.trim() === '') {
    return;
  }
  const queue = createAsyncQueue<Uint8Array>();
  let socket: RealtimeSocket | null = null;
  const abort = (): void => {
    queue.fail(abortedError(scope));
  };
  signal.addEventListener('abort', abort, { once: true });
  // A socket listener runs outside this generator: what it throws fails the call instead.
  const guarded =
    (listener: (data: unknown) => void) =>
    (event: { readonly data?: unknown }): void => {
      try {
        listener(event.data);
      } catch (error) {
        queue.fail(toSpeechError(scope, error, signal));
      }
    };
  try {
    const events = utterance(text, speaker.voice, speaker.instructions());
    socket = speaker.open(speaker.url, { Authorization: `Bearer ${speaker.apiKey}` });
    const opened = socket;
    opened.addEventListener(
      'open',
      guarded(() => {
        for (const event of events) {
          opened.send(JSON.stringify(event));
        }
      }),
    );
    opened.addEventListener(
      'message',
      guarded((data) => {
        onEvent(scope, queue, data);
      }),
    );
    const dropped = guarded(() => {
      queue.fail(endedEarly(scope));
    });
    opened.addEventListener('error', dropped);
    opened.addEventListener('close', dropped);
    yield* queue;
  } catch (error) {
    throw toSpeechError(scope, error, signal);
  } finally {
    signal.removeEventListener('abort', abort);
    queue.end();
    socket?.close();
  }
}

/**
 * Creates the `text-to-speech` entity `openai/<model>`.
 *
 * The entity never retries, and keeps no connection between utterances: a failed call is
 * one `SpeechError`, and its `retryable` flag tells the caller whether to try again.
 */
export function createOpenAiTextToSpeech(options: OpenAiTextToSpeechOptions): TextToSpeech {
  const model = options.model ?? OPENAI_TTS_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const speaker: Speaker = {
    scope: { provider: OPENAI, model, secrets: [options.apiKey] },
    url: realtimeUrl(baseUrl, model),
    voice: options.voice ?? OPENAI_TTS_VOICE,
    apiKey: options.apiKey,
    instructions: options.instructions,
    open: options.socket ?? openSocket,
  };
  return {
    ref: { kind: 'text-to-speech', id: `${OPENAI}/${model}`, version: null },
    description: t('speech.openai-tts.description', { model }),
    locality: { type: 'remote', protocol: 'https', url: baseUrl },
    format: FORMAT,
    synthesize: (text: string, signal: AbortSignal): AsyncIterable<Uint8Array> =>
      speak(speaker, text, signal),
  };
}
