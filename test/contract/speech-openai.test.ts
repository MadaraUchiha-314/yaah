/**
 * The OpenAI speech providers against the speech contracts and their own mapping rules.
 * Speech to text replays HTTP through the SDK's `fetch` option; text to speech talks to a
 * scripted socket. The fixtures under `test/fixtures/speech/openai/` are hand-written
 * from the documented shapes of the APIs — see the README there; none is a recording.
 */
import { describe, expect, test } from 'bun:test';

import type { FetchLike } from '../../src/harness/models/llm/openai/content.ts';
import { createOpenAiSpeechToText } from '../../src/harness/models/speech/openai-stt/provider.ts';
import {
  createOpenAiTextToSpeech,
  realtimeUrl,
} from '../../src/harness/models/speech/openai-tts/provider.ts';
import type { SpeechToText, TextToSpeech } from '../../src/harness/models/speech/types.ts';
import { SpeechError, transcriptOf } from '../../src/harness/models/speech/types.ts';
import {
  SPEECH_CONTRACT_AUDIO,
  SPEECH_CONTRACT_TEXT,
  speechToTextContract,
  textToSpeechContract,
} from '../../src/testing/speech-contract.ts';
import { json, sse } from '../support/llm-http.ts';
import type { SocketScript } from '../support/media.ts';
import { mediaFixture, scriptedSockets } from '../support/media.ts';

const KEY = 'sk-fixture-secret-key-0003';
const fixture = (name: string): string => mediaFixture('speech', 'openai', name);
const live = (): AbortSignal => new AbortController().signal;

interface Upload {
  readonly url: string;
  readonly authorization: string | null;
  readonly form: FormData | null;
}

/** A fake `fetch` that answers every request with `response` and keeps what was uploaded. */
function uploads(response: () => Response): { fetch: FetchLike; seen: Upload[] } {
  const seen: Upload[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const body: unknown = init?.body;
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      form: body instanceof FormData ? body : null,
    });
    return response();
  };
  return { fetch: fake, seen };
}

function stt(response: () => Response): SpeechToText {
  return createOpenAiSpeechToText({ apiKey: KEY, fetch: uploads(response).fetch });
}

function tts(script: SocketScript): TextToSpeech {
  return createOpenAiTextToSpeech({
    apiKey: KEY,
    instructions: () => 'Read the text aloud.',
    socket: scriptedSockets(script).open,
  });
}

async function failure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

async function spoken(model: TextToSpeech, text: string, signal = live()): Promise<number[][]> {
  const chunks: number[][] = [];
  for await (const chunk of model.synthesize(text, signal)) {
    chunks.push([...chunk]);
  }
  return chunks;
}

speechToTextContract({ describe, expect, test }, 'openai', {
  transcribes: () => stt(sse(fixture('transcription.sse'))),
  retryableError: () => stt(json(429, fixture('error-429.json'))),
  fatalError: () => stt(json(400, fixture('error-400.json'))),
});

textToSpeechContract({ describe, expect, test }, 'openai', {
  speaks: () => tts({ events: fixture('realtime-speech.jsonl') }),
  retryableError: () => tts({ events: fixture('realtime-failed.jsonl') }),
  fatalError: () => tts({ events: fixture('realtime-error.jsonl') }),
});

describe('openai speech to text', () => {
  test('is addressed as openai/gpt-transcribe by default and reached over https', () => {
    const model = stt(sse(fixture('transcription.sse')));
    expect(model.ref).toEqual({
      kind: 'speech-to-text',
      id: 'openai/gpt-transcribe',
      version: null,
    });
    expect(model.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://api.openai.com/v1',
    });
    expect(model.description).toContain('gpt-transcribe');
  });

  test('uploads the recording to /audio/transcriptions, streamed, under a name of its own', async () => {
    const http = uploads(sse(fixture('transcription.sse')));
    const model = createOpenAiSpeechToText({
      apiKey: KEY,
      model: 'gpt-4o-transcribe',
      baseUrl: 'https://proxy.example/v1',
      fetch: http.fetch,
    });
    const audio = { ...SPEECH_CONTRACT_AUDIO, mediaType: 'audio/webm;codecs=opus', name: '../x' };
    expect(await transcriptOf(model, audio, live())).toBe('Where is my order?');
    const upload = http.seen.find((sent) => !sent.url.startsWith('data:'));
    expect(upload?.url).toBe('https://proxy.example/v1/audio/transcriptions');
    expect(upload?.authorization).toBe(`Bearer ${KEY}`);
    expect(upload?.form?.get('model')).toBe('gpt-4o-transcribe');
    expect(upload?.form?.get('stream')).toBe('true');
    const file = upload?.form?.get('file');
    expect(file instanceof File && file.name).toBe('audio.webm');
    expect(file instanceof File && file.type).toBe('audio/webm');
    expect(file instanceof File ? file.size : -1).toBe(SPEECH_CONTRACT_AUDIO.data.length);
  });

  test('streams the deltas in order before the whole transcript', async () => {
    const events = [];
    const model = stt(sse(fixture('transcription.sse')));
    for await (const event of model.transcribe(SPEECH_CONTRACT_AUDIO, live())) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'delta', text: 'Where ' },
      { type: 'delta', text: 'is my ' },
      { type: 'delta', text: 'order?' },
      { type: 'done', text: 'Where is my order?' },
    ]);
  });

  test('a stream that ends before it is done is a retryable failure', async () => {
    const model = stt(sse(fixture('transcription-truncated.sse')));
    const error = await failure(() => transcriptOf(model, SPEECH_CONTRACT_AUDIO, live()));
    expect(error instanceof SpeechError && error.retryable).toBe(true);
  });

  test('a format the API does not take is refused before anything is sent', async () => {
    const http = uploads(sse(fixture('transcription.sse')));
    const model = createOpenAiSpeechToText({ apiKey: KEY, fetch: http.fetch });
    const audio = { data: Uint8Array.from([1]), mediaType: 'audio/x-unknown' };
    const error = await failure(() => transcriptOf(model, audio, live()));
    expect(error instanceof SpeechError && error.retryable).toBe(false);
    expect(error instanceof Error ? error.message : '').toContain('audio/x-unknown');
    expect(http.seen.filter((sent) => !sent.url.startsWith('data:')).length).toBe(0);
  });

  test('an error never carries the key or the text of the upstream body', async () => {
    const body = JSON.stringify({ error: { message: `bad key ${KEY}`, code: KEY } });
    const error = await failure(() =>
      transcriptOf(stt(json(401, body)), SPEECH_CONTRACT_AUDIO, live()),
    );
    expect(error instanceof SpeechError && error.retryable).toBe(false);
    expect(error instanceof Error ? error.message : KEY).not.toContain(KEY);
  });
});

describe('openai text to speech', () => {
  test('is addressed as openai/gpt-realtime-2.1-mini and yields 24 kHz mono PCM', () => {
    const model = tts({ events: fixture('realtime-speech.jsonl') });
    expect(model.ref.id).toBe('openai/gpt-realtime-2.1-mini');
    expect(model.format).toEqual({ mediaType: 'audio/pcm', sampleRate: 24_000, channels: 1 });
    expect(model.description).toContain('gpt-realtime-2.1-mini');
  });

  test('derives the socket address from the HTTP base URL', () => {
    expect(realtimeUrl('https://api.openai.com/v1', 'gpt-realtime-2.1-mini')).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini',
    );
    expect(realtimeUrl('http://localhost:8080/v1/?x=1', 'm')).toBe(
      'ws://localhost:8080/v1/realtime?model=m',
    );
  });

  test('configures the session, adds the text, asks for a response, and decodes the audio', async () => {
    const sockets = scriptedSockets({ events: fixture('realtime-speech.jsonl') });
    const model = createOpenAiTextToSpeech({
      apiKey: KEY,
      voice: 'cedar',
      instructions: () => 'Read the text aloud.',
      socket: sockets.open,
    });
    expect(await spoken(model, SPEECH_CONTRACT_TEXT)).toEqual([
      [0, 0, 1, 0, 2, 0, 3, 0],
      [4, 0, 5, 0],
    ]);
    const [connection] = sockets.connections;
    expect(connection?.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(connection?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(connection?.sent).toEqual([
      {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: 'Read the text aloud.',
          output_modalities: ['audio'],
          audio: { output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'cedar' } },
        },
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: SPEECH_CONTRACT_TEXT }],
        },
      },
      { type: 'response.create' },
    ]);
    expect(connection?.closed).toBe(true);
  });

  test('opens no connection for a text with nothing to say', async () => {
    const sockets = scriptedSockets({ silent: true });
    const model = createOpenAiTextToSpeech({
      apiKey: KEY,
      instructions: () => '',
      socket: sockets.open,
    });
    expect(await spoken(model, ' \n ')).toEqual([]);
    expect(sockets.connections.length).toBe(0);
  });

  test('a connection that drops before the response is done is a retryable failure', async () => {
    const error = await failure(() => spoken(tts({ drop: true }), SPEECH_CONTRACT_TEXT));
    expect(error instanceof SpeechError && error.retryable).toBe(true);
  });

  test('an abort during synthesis closes the socket and ends the call', async () => {
    const sockets = scriptedSockets({ silent: true });
    const model = createOpenAiTextToSpeech({
      apiKey: KEY,
      instructions: () => '',
      socket: sockets.open,
    });
    const controller = new AbortController();
    const pending = failure(() => spoken(model, SPEECH_CONTRACT_TEXT, controller.signal));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    controller.abort();
    const error = await pending;
    expect(error instanceof SpeechError && error.retryable).toBe(false);
    expect(sockets.connections[0]?.closed).toBe(true);
  });

  test('a socket that cannot be opened is a failure, not a crash', async () => {
    const model = createOpenAiTextToSpeech({
      apiKey: KEY,
      instructions: () => '',
      socket: () => {
        throw new Error(`cannot connect with ${KEY}`);
      },
    });
    const error = await failure(() => spoken(model, SPEECH_CONTRACT_TEXT));
    expect(error instanceof SpeechError).toBe(true);
    expect(error instanceof Error ? error.message : KEY).not.toContain(KEY);
  });

  test('frames that are not events are ignored', async () => {
    const events = `not json\n{"no":"type"}\n${fixture('realtime-speech.jsonl')}`;
    expect((await spoken(tts({ events }), SPEECH_CONTRACT_TEXT)).length).toBe(2);
  });
});
