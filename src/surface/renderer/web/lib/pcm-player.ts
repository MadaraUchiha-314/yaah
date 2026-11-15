/**
 * Plays a spoken answer with Web Audio as its pieces arrive. Each piece is raw 16-bit
 * PCM; it becomes an audio buffer scheduled to start exactly where the piece before it
 * ends, so the speech is continuous however the network cut it up.
 */
import type { SpeechChunk } from '../../../view-files.ts';

/** A piece of audio that was scheduled. */
export interface ScheduledAudio {
  /** How long it plays, in seconds. */
  readonly duration: number;
  stop(): void;
}

/** Where the player sends sound: the slice of Web Audio it needs. */
export interface AudioOutput {
  /** The output's clock, in seconds. */
  readonly currentTime: number;
  /** Makes sure the output is running; a browser suspends it until the user acts. */
  resume(): void;
  /**
   * Schedules `channels` — one array of samples in -1..1 per channel — to start at
   * `startAt` on the output's clock, and calls `onEnded` when it has played.
   */
  schedule(
    channels: readonly Float32Array[],
    sampleRate: number,
    startAt: number,
    onEnded: () => void,
  ): ScheduledAudio;
}

/** What the player tells the page: whether speech is playing, and how much has arrived. */
export interface PlayerState {
  readonly speaking: boolean;
  /** Pieces of audio scheduled since the page opened. */
  readonly chunks: number;
}

const BYTES_PER_SAMPLE = 2;
const FULL_SCALE = 0x80_00;
/** A little ahead of now, so the first piece does not start in the past. */
const LEAD_SECONDS = 0.05;

/** The browser's audio output: one `AudioContext`, opened when first needed. */
export function webAudioOutput(): AudioOutput {
  const context = new AudioContext();
  return {
    get currentTime(): number {
      return context.currentTime;
    },
    resume: (): void => {
      if (context.state === 'suspended') {
        void context.resume();
      }
    },
    schedule: (channels, sampleRate, startAt, onEnded): ScheduledAudio => {
      const frames = channels[0]?.length ?? 0;
      const buffer = context.createBuffer(channels.length, frames, sampleRate);
      for (const [index, samples] of channels.entries()) {
        buffer.getChannelData(index).set(samples);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.addEventListener('ended', onEnded, { once: true });
      source.start(startAt);
      return {
        duration: buffer.duration,
        stop: (): void => {
          source.stop();
        },
      };
    },
  };
}

/** Plays `audio/pcm` speech pieces in the order they are given. */
export class PcmPlayer {
  readonly #create: () => AudioOutput;
  readonly #listeners = new Set<() => void>();
  readonly #playing = new Set<ScheduledAudio>();
  #output: AudioOutput | null = null;
  #state: PlayerState = { speaking: false, chunks: 0 };
  /** When the audio scheduled so far ends, on the output's clock. */
  #endsAt = 0;
  /** A byte left over when a piece ended in the middle of a sample. */
  #carry: number | null = null;
  #artifactId = '';
  /** Set by {@link PcmPlayer.stop}: pieces still arriving are dropped until enabled again. */
  #muted = false;

  /** @param create Opens the audio output; tests pass their own. */
  constructor(create: () => AudioOutput = webAudioOutput) {
    this.#create = create;
  }

  /** The current state. The same object until something changes. */
  readonly getState = (): PlayerState => this.#state;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Opens the audio output. A browser lets a page make sound only after the user acted
   * on it, so this is called from the click that turns voice output on.
   */
  readonly enable = (): void => {
    this.#muted = false;
    this.#output ??= this.#create();
    this.#output.resume();
  };

  /**
   * Stops what is playing, drops what was scheduled, and stays silent — the rest of an
   * answer still streaming in included — until {@link PcmPlayer.enable} is called again.
   */
  readonly stop = (): void => {
    this.#muted = true;
    for (const scheduled of this.#playing) {
      scheduled.stop();
    }
    this.#playing.clear();
    this.#endsAt = 0;
    this.#carry = null;
    this.#set({ speaking: false });
  };

  /** Schedules one piece. Ignored until {@link PcmPlayer.enable} was called, and after a stop. */
  readonly play = (chunk: SpeechChunk): void => {
    const output = this.#output;
    if (output === null || this.#muted) {
      return;
    }
    if (chunk.artifactId !== this.#artifactId) {
      this.#artifactId = chunk.artifactId;
      this.#carry = null;
    }
    const samples = this.#samples(chunk.data);
    const frames = Math.floor(samples.length / chunk.channels);
    if (frames === 0) {
      return;
    }
    const channels = Array.from({ length: chunk.channels }, (_, channel) =>
      Float32Array.from(
        { length: frames },
        (__, frame) => (samples[frame * chunk.channels + channel] ?? 0) / FULL_SCALE,
      ),
    );
    const startAt = Math.max(this.#endsAt, output.currentTime + LEAD_SECONDS);
    const scheduled: ScheduledAudio = output.schedule(channels, chunk.sampleRate, startAt, () => {
      this.#playing.delete(scheduled);
      if (this.#playing.size === 0 && this.#state.speaking) {
        this.#set({ speaking: false });
      }
    });
    this.#endsAt = startAt + scheduled.duration;
    this.#playing.add(scheduled);
    this.#set({ speaking: true, chunks: this.#state.chunks + 1 });
  };

  /** The whole samples of `bytes`, joined with the byte carried over from the piece before. */
  #samples(bytes: Uint8Array): Int16Array {
    const joined = this.#carry === null ? bytes : Uint8Array.from([this.#carry, ...bytes]);
    const whole = joined.length - (joined.length % BYTES_PER_SAMPLE);
    this.#carry = whole < joined.length ? (joined[whole] ?? null) : null;
    const view = new DataView(joined.buffer, joined.byteOffset, whole);
    const samples = new Int16Array(whole / BYTES_PER_SAMPLE);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * BYTES_PER_SAMPLE, true);
    }
    return samples;
  }

  #set(change: Partial<PlayerState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
