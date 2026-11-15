/**
 * Speaking an answer while it is being written. Text is taken from the model's stream,
 * cut at sentence ends, and handed to a text-to-speech model one stretch at a time; the
 * audio that comes back is passed on as it is produced. Whatever sentences completed
 * while one stretch was being spoken form the next stretch.
 *
 * Speech never holds an answer back or fails it: if synthesis fails, the rest of the
 * answer is simply not spoken.
 */
import type { SpeechToText, TextToSpeech } from '../models/speech/types.ts';
import type { StepContext } from './direct-runner.ts';
import type { StreamSink, StreamedAudio, TaskSnapshot } from './task-port.ts';

/** The speech models the steps use. */
export interface SpeechDeps {
  /** The model that transcribes audio for a model that does not accept it, or null. */
  stt(): SpeechToText | null;
  /** The model that speaks this turn's answer, or null when the turn is not spoken. */
  tts(task: TaskSnapshot): TextToSpeech | null;
  /** Told when speaking an answer failed. */
  onError?(taskId: string, error: unknown): void;
}

/** What a {@link SpokenReply} is given. */
export interface SpokenReplyInit {
  readonly tts: TextToSpeech;
  /** Receives each piece of audio as it is produced. */
  readonly emit: (chunk: StreamedAudio) => void;
  /** Aborted when the step is abandoned: synthesis stops. */
  readonly signal: AbortSignal;
  /** Told when synthesis fails; the answer itself goes on. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** A sentence end followed by white space, or a line end. */
const BOUNDARY = /[.!?…。！？][)"'\]]*\s|\n/gu;

/** Where the last complete sentence of `text` ends, or 0 when it has none. */
function lastBoundary(text: string): number {
  let end = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    end = match.index + match[0].length;
  }
  return end;
}

/** The spoken form of one answer, produced alongside its text. */
export class SpokenReply {
  readonly #init: SpokenReplyInit;
  #pending = '';
  #running: Promise<void> | null = null;
  #held: Uint8Array | null = null;
  #failed = false;
  /** Aborted when the answer is abandoned, or when the step is. */
  readonly #stop = new AbortController();

  constructor(init: SpokenReplyInit) {
    this.#init = init;
    const stop = (): void => {
      this.#stop.abort();
    };
    if (init.signal.aborted) {
      stop();
    }
    init.signal.addEventListener('abort', stop, { once: true });
  }

  /**
   * Stops speaking at once and for good: the answer being spoken was lost — its model
   * call failed and will be made again. Nothing more is emitted.
   */
  abandon(): void {
    this.#failed = true;
    this.#held = null;
    this.#stop.abort();
  }

  /** Takes the next piece of the answer's text. Returns at once. */
  say(text: string): void {
    this.#pending += text;
    this.#pump(false);
  }

  /** Speaks what is left, waits for the audio, and marks its last piece. */
  async finish(): Promise<void> {
    for (let running = this.#running; running !== null; running = this.#running) {
      // oxlint-disable-next-line no-await-in-loop -- stretches are spoken one after another
      await running;
    }
    this.#pump(true);
    await this.#last();
    if (this.#held !== null) {
      this.#emit(this.#held, true);
      this.#held = null;
    }
  }

  /** Starts speaking the next stretch, unless one is being spoken. */
  #pump(all: boolean): void {
    if (this.#running !== null || this.#failed) {
      return;
    }
    const end = all ? this.#pending.length : lastBoundary(this.#pending);
    const stretch = this.#pending.slice(0, end);
    if (stretch.trim() === '') {
      return;
    }
    this.#pending = this.#pending.slice(end);
    this.#running = this.#speakThenNext(stretch, all);
  }

  /** The stretch being spoken, if any. */
  #last(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #speakThenNext(stretch: string, all: boolean): Promise<void> {
    await this.#speak(stretch);
    this.#running = null;
    if (!all) {
      this.#pump(false);
    }
  }

  async #speak(text: string): Promise<void> {
    try {
      for await (const chunk of this.#init.tts.synthesize(text, this.#stop.signal)) {
        if (this.#stop.signal.aborted) {
          return;
        }
        // One piece is held back, so the last one can be marked as the last.
        if (this.#held !== null) {
          this.#emit(this.#held, false);
        }
        this.#held = chunk;
      }
    } catch (error) {
      if (!this.#stop.signal.aborted) {
        this.#init.onError?.(error);
      }
      this.#failed = true;
    }
  }

  #emit(chunk: Uint8Array, last: boolean): void {
    const { format } = this.#init.tts;
    this.#init.emit({
      mediaType: format.mediaType,
      sampleRate: format.sampleRate,
      channels: format.channels,
      data: Buffer.from(chunk).toString('base64'),
      last,
    });
  }
}

/**
 * Opens the spoken form of the answer step `ctx` is about to produce, when the turn asks
 * for one and the sink can carry audio; null otherwise.
 */
export function openSpokenReply(
  speech: SpeechDeps | undefined,
  sink: StreamSink,
  ctx: StepContext,
  task: TaskSnapshot,
): SpokenReply | null {
  const tts = speech?.tts(task) ?? null;
  if (tts === null || sink.audio === undefined) {
    return null;
  }
  return new SpokenReply({
    tts,
    signal: ctx.signal,
    emit: (chunk: StreamedAudio): void => {
      sink.audio?.(ctx.taskId, ctx.key, chunk);
    },
    onError: (error: unknown): void => {
      speech?.onError?.(ctx.taskId, error);
    },
  });
}
