/**
 * The speech interfaces: turning recorded audio into text and text into audio. Both are
 * separate from the LLM interface — no conversation, no tools. Every provider is a
 * `speech-to-text` or a `text-to-speech` entity; nothing above this file knows which
 * provider it is talking to.
 */
import type { Entity } from '../../../kernel/entity.ts';
import { YaahError } from '../../../kernel/errors.ts';

declare module '../../../kernel/entity.ts' {
  interface EntityMap {
    'speech-to-text': SpeechToText;
    'text-to-speech': TextToSpeech;
  }
}

/** A recording to transcribe. */
export interface AudioInput {
  /** The encoded audio, whole. */
  readonly data: Uint8Array;
  /** `audio/webm`, `audio/wav`, … — how `data` is encoded. */
  readonly mediaType: string;
  /** A file name, when the recording has one. */
  readonly name?: string | undefined;
}

/**
 * What a transcription emits.
 *
 * Invariants: `done` is emitted exactly once and is the last event; its `text` is the
 * whole transcript, and equals the `delta` texts joined when any were emitted.
 */
export type TranscriptEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly text: string };

/** A model that writes down what was said. */
export interface SpeechToText extends Entity<'speech-to-text'> {
  /**
   * Streams the transcript of `audio` as it is recognised.
   *
   * Aborting `signal` ends the stream promptly; the iterator then throws.
   *
   * @throws SpeechError when the provider fails or the call is aborted. `retryable` says
   *   whether trying again can help.
   */
  transcribe(audio: AudioInput, signal: AbortSignal): AsyncIterable<TranscriptEvent>;
}

/** How the audio a {@link TextToSpeech} produces is encoded. */
export interface AudioFormat {
  /** `audio/pcm`: raw signed 16-bit little-endian samples, no container. */
  readonly mediaType: string;
  /** Samples per second. */
  readonly sampleRate: number;
  readonly channels: number;
}

/** A model that says a text aloud. */
export interface TextToSpeech extends Entity<'text-to-speech'> {
  /** The encoding of every chunk this model yields. */
  readonly format: AudioFormat;
  /**
   * Streams the spoken form of `text` as it is synthesised: chunks of raw audio in
   * {@link TextToSpeech.format}, none empty, that joined are the whole utterance. A text
   * with something to say yields at least one chunk.
   *
   * Aborting `signal` ends the stream promptly; the iterator then throws.
   *
   * @throws SpeechError when the provider fails or the call is aborted.
   */
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** A speech call failed. */
export class SpeechError extends YaahError {
  readonly provider: string;
  readonly model: string;
  /** True for rate limits, timeouts and server errors; false for bad requests and auth. */
  readonly retryable: boolean;

  constructor(
    provider: string,
    model: string,
    retryable: boolean,
    message: string,
    cause?: unknown,
  ) {
    super(retryable ? 'speech.retryable' : 'speech.fatal', message, cause);
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
  }
}

/**
 * The whole transcript of `audio`.
 *
 * @throws SpeechError as {@link SpeechToText.transcribe} does.
 */
export async function transcriptOf(
  model: SpeechToText,
  audio: AudioInput,
  signal: AbortSignal,
): Promise<string> {
  let text = '';
  for await (const event of model.transcribe(audio, signal)) {
    if (event.type === 'done') {
      ({ text } = event);
    }
  }
  return text;
}
