/**
 * Speech models that replay a script — deterministic and offline. Each records every
 * call it receives, so a test can assert on exactly what was transcribed or spoken, and
 * whether anything was at all.
 */
import { LOCAL } from '../kernel/entity.ts';
import type {
  AudioFormat,
  AudioInput,
  SpeechToText,
  TextToSpeech,
  TranscriptEvent,
} from '../harness/models/speech/types.ts';
import { SpeechError } from '../harness/models/speech/types.ts';

const PROVIDER = 'scripted';

/** What a scripted speech-to-text model does on one call: a transcript, or a failure. */
export type ScriptedTranscript = string | { readonly error: SpeechError };

/** What a scripted text-to-speech model does on one call. */
export type ScriptedUtterance =
  | readonly Uint8Array[]
  | ((text: string) => readonly Uint8Array[])
  | { readonly error: SpeechError };

/** Options of the scripted speech models. */
export interface ScriptedSpeechOptions {
  readonly id?: string;
  /** Milliseconds to wait before each event or chunk, to make streaming observable. */
  readonly delayMs?: number;
}

function wait(ms: number, signal: AbortSignal, aborted: () => SpeechError): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: SpeechError) => void) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(aborted());
      },
      { once: true },
    );
  });
}

/** A scripted `speech-to-text` entity. The last transcript of the script repeats. */
export class ScriptedSpeechToText implements SpeechToText {
  readonly ref: SpeechToText['ref'];
  readonly description = 'A scripted speech-to-text model for tests.';
  readonly locality: SpeechToText['locality'] = LOCAL;
  /** Every recording received, in order. */
  readonly calls: AudioInput[] = [];
  readonly #script: readonly ScriptedTranscript[];
  readonly #delayMs: number;

  constructor(script: readonly ScriptedTranscript[], options: ScriptedSpeechOptions = {}) {
    this.#script = [...script];
    this.#delayMs = options.delayMs ?? 0;
    this.ref = { kind: 'speech-to-text', id: options.id ?? 'scripted/stt', version: null };
  }

  /**
   * Plays the next transcript of the script, a word at a time.
   *
   * @throws SpeechError when the script says so, when it is empty, or when `signal` aborts.
   */
  async *transcribe(audio: AudioInput, signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
    const aborted = (): SpeechError => new SpeechError(PROVIDER, this.ref.id, false, 'aborted');
    const transcript = this.#script[Math.min(this.calls.length, this.#script.length - 1)];
    this.calls.push(audio);
    await wait(this.#delayMs, signal, aborted);
    if (transcript === undefined) {
      throw new SpeechError(PROVIDER, this.ref.id, false, 'the script is empty');
    }
    if (typeof transcript !== 'string') {
      throw transcript.error;
    }
    for (const word of transcript.match(/\S+\s*/gu) ?? []) {
      yield { type: 'delta', text: word };
      // oxlint-disable-next-line no-await-in-loop -- words are emitted one after another
      await wait(this.#delayMs, signal, aborted);
    }
    yield { type: 'done', text: transcript };
  }
}

/**
 * An utterance that sounds like nothing but has the length of its text: one chunk of
 * silence per word, `bytesPerWord` bytes each.
 */
export function silencePerWord(bytesPerWord = 8): (text: string) => readonly Uint8Array[] {
  return (text: string): readonly Uint8Array[] =>
    (text.match(/\S+/gu) ?? []).map(() => new Uint8Array(bytesPerWord));
}

/** A scripted `text-to-speech` entity. The last utterance of the script repeats. */
export class ScriptedTextToSpeech implements TextToSpeech {
  readonly ref: TextToSpeech['ref'];
  readonly description = 'A scripted text-to-speech model for tests.';
  readonly locality: TextToSpeech['locality'] = LOCAL;
  readonly format: AudioFormat = { mediaType: 'audio/pcm', sampleRate: 24_000, channels: 1 };
  /** Every text received, in order. */
  readonly calls: string[] = [];
  readonly #script: readonly ScriptedUtterance[];
  readonly #delayMs: number;

  constructor(
    script: readonly ScriptedUtterance[] = [silencePerWord()],
    options: ScriptedSpeechOptions = {},
  ) {
    this.#script = [...script];
    this.#delayMs = options.delayMs ?? 0;
    this.ref = { kind: 'text-to-speech', id: options.id ?? 'scripted/tts', version: null };
  }

  /**
   * Plays the next utterance of the script, a chunk at a time.
   *
   * @throws SpeechError when the script says so, when it is empty, or when `signal` aborts.
   */
  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const aborted = (): SpeechError => new SpeechError(PROVIDER, this.ref.id, false, 'aborted');
    const utterance = this.#script[Math.min(this.calls.length, this.#script.length - 1)];
    this.calls.push(text);
    await wait(this.#delayMs, signal, aborted);
    if (utterance === undefined) {
      throw new SpeechError(PROVIDER, this.ref.id, false, 'the script is empty');
    }
    if (typeof utterance !== 'function' && 'error' in utterance) {
      throw utterance.error;
    }
    for (const chunk of typeof utterance === 'function' ? utterance(text) : utterance) {
      yield chunk;
      // oxlint-disable-next-line no-await-in-loop -- chunks are emitted one after another
      await wait(this.#delayMs, signal, aborted);
    }
  }
}
