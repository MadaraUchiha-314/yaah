import type {
  SpeechToText,
  TextToSpeech,
  TranscriptEvent,
} from '../harness/models/speech/types.ts';
import { SpeechError, transcriptOf } from '../harness/models/speech/types.ts';
import type { ContractApi } from './contract-api.ts';

/**
 * How a test makes a speech-to-text implementation produce each situation the contract
 * checks. For a real provider this is done with canned responses; no network is involved.
 */
export interface SpeechToTextContractSubject {
  /** A model that will transcribe {@link SPEECH_CONTRACT_AUDIO} as some non-empty text. */
  transcribes(): SpeechToText;
  /** A model whose provider fails with a rate limit or a server error. */
  retryableError(): SpeechToText;
  /** A model whose provider rejects the request (bad request or authentication). */
  fatalError(): SpeechToText;
}

/** How a test makes a text-to-speech implementation produce each situation. */
export interface TextToSpeechContractSubject {
  /** A model that will speak {@link SPEECH_CONTRACT_TEXT}. */
  speaks(): TextToSpeech;
  /** A model whose provider fails with a rate limit or a server error. */
  retryableError(): TextToSpeech;
  /** A model whose provider rejects the request. */
  fatalError(): TextToSpeech;
}

/** The recording every transcription of the contract is given: a few bytes, typed as WAV. */
export const SPEECH_CONTRACT_AUDIO: { readonly data: Uint8Array; readonly mediaType: string } = {
  data: Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0]),
  mediaType: 'audio/wav',
};

/** The text every synthesis of the contract is given. */
export const SPEECH_CONTRACT_TEXT: string = 'Your order ships today.';

const live = (): AbortSignal => new AbortController().signal;

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

async function events(model: SpeechToText, signal: AbortSignal): Promise<TranscriptEvent[]> {
  const seen: TranscriptEvent[] = [];
  for await (const event of model.transcribe(SPEECH_CONTRACT_AUDIO, signal)) {
    seen.push(event);
  }
  return seen;
}

async function chunks(model: TextToSpeech, signal: AbortSignal): Promise<Uint8Array[]> {
  const seen: Uint8Array[] = [];
  for await (const chunk of model.synthesize(SPEECH_CONTRACT_TEXT, signal)) {
    seen.push(chunk);
  }
  return seen;
}

function expectSpeechError(api: ContractApi, error: unknown, retryable: boolean | null): void {
  api.expect(error instanceof SpeechError).toBe(true);
  if (error instanceof SpeechError && retryable !== null) {
    api.expect(error.retryable).toBe(retryable);
    api.expect(error.model.length > 0 && error.provider.length > 0).toBe(true);
  }
}

/**
 * The contract every `speech-to-text` entity must keep. Run it against a provider of
 * your own before registering it.
 */
export function speechToTextContract(
  api: ContractApi,
  name: string,
  subject: SpeechToTextContractSubject,
): void {
  const { describe, expect, test } = api;
  describe(`speech-to-text contract: ${name}`, () => {
    test('declares its address', () => {
      const model = subject.transcribes();
      expect(model.ref.kind).toBe('speech-to-text');
      expect(model.ref.id.length > 0).toBe(true);
    });

    test('ends with exactly one done event that carries the whole transcript', async () => {
      const seen = await events(subject.transcribes(), live());
      const done = seen.filter((event) => event.type === 'done');
      expect(done.length).toBe(1);
      expect(seen.at(-1)?.type).toBe('done');
      expect((seen.at(-1)?.text ?? '').length > 0).toBe(true);
    });

    test('the deltas, when there are any, join to the transcript', async () => {
      const seen = await events(subject.transcribes(), live());
      const deltas = seen.filter((event) => event.type === 'delta').map((event) => event.text);
      const whole = seen.at(-1)?.text ?? '';
      expect(deltas.length === 0 || deltas.join('') === whole).toBe(true);
      expect(await transcriptOf(subject.transcribes(), SPEECH_CONTRACT_AUDIO, live())).toBe(whole);
    });

    test('a rate limit or server error is a SpeechError marked retryable', async () => {
      expectSpeechError(api, await caught(() => events(subject.retryableError(), live())), true);
    });

    test('a rejected request is a SpeechError marked not retryable', async () => {
      expectSpeechError(api, await caught(() => events(subject.fatalError(), live())), false);
    });

    test('an aborted signal ends the call with a SpeechError', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await caught(() => events(subject.transcribes(), controller.signal));
      expectSpeechError(api, error, null);
    });
  });
}

/**
 * The contract every `text-to-speech` entity must keep. Run it against a provider of
 * your own before registering it.
 */
export function textToSpeechContract(
  api: ContractApi,
  name: string,
  subject: TextToSpeechContractSubject,
): void {
  const { describe, expect, test } = api;
  describe(`text-to-speech contract: ${name}`, () => {
    test('declares its address and the format of its audio', () => {
      const model = subject.speaks();
      expect(model.ref.kind).toBe('text-to-speech');
      expect(model.ref.id.length > 0).toBe(true);
      expect(model.format.mediaType).toBe('audio/pcm');
      expect(model.format.sampleRate > 0 && model.format.channels > 0).toBe(true);
    });

    test('yields at least one chunk of audio, and no empty chunk', async () => {
      const seen = await chunks(subject.speaks(), live());
      expect(seen.length > 0).toBe(true);
      expect(seen.every((chunk) => chunk.length > 0)).toBe(true);
    });

    test('yields nothing for a text with nothing to say', async () => {
      const seen: Uint8Array[] = [];
      for await (const chunk of subject.speaks().synthesize('   ', live())) {
        seen.push(chunk);
      }
      expect(seen.length).toBe(0);
    });

    test('a rate limit or server error is a SpeechError marked retryable', async () => {
      expectSpeechError(api, await caught(() => chunks(subject.retryableError(), live())), true);
    });

    test('a rejected request is a SpeechError marked not retryable', async () => {
      expectSpeechError(api, await caught(() => chunks(subject.fatalError(), live())), false);
    });

    test('an aborted signal ends the call with a SpeechError', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await caught(() => chunks(subject.speaks(), controller.signal));
      expectSpeechError(api, error, null);
    });
  });
}
