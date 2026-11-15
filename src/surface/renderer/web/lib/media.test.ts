import { describe, expect, test } from 'bun:test';

import type { SpeechChunk } from '../../../view-files.ts';
import type { AudioOutput } from './pcm-player.ts';
import { PcmPlayer, webAudioOutput } from './pcm-player.ts';
import type { MediaEncoder, MicStream, RecorderScope } from './recorder.ts';
import { MicError, recordFromBrowser, startRecording } from './recorder.ts';

interface Scheduled {
  readonly samples: number[][];
  readonly sampleRate: number;
  readonly startAt: number;
  stopped: boolean;
  readonly end: () => void;
}

/** An audio output that plays nothing and remembers what it was asked to play. */
class FakeOutput implements AudioOutput {
  readonly scheduled: Scheduled[] = [];
  resumed = 0;
  currentTime = 10;

  resume(): void {
    this.resumed += 1;
  }

  schedule(
    channels: readonly Float32Array[],
    sampleRate: number,
    startAt: number,
    onEnded: () => void,
  ): { duration: number; stop: () => void } {
    const entry: Scheduled = {
      samples: channels.map((channel) => [...channel]),
      sampleRate,
      startAt,
      stopped: false,
      end: onEnded,
    };
    this.scheduled.push(entry);
    return {
      duration: (channels[0]?.length ?? 0) / sampleRate,
      stop: (): void => {
        entry.stopped = true;
      },
    };
  }
}

function chunk(bytes: readonly number[], change: Partial<SpeechChunk> = {}): SpeechChunk {
  return {
    artifactId: 'speech-1',
    data: Uint8Array.from(bytes),
    sampleRate: 24_000,
    channels: 1,
    last: false,
    ...change,
  };
}

function enabled(): { output: FakeOutput; player: PcmPlayer } {
  const output = new FakeOutput();
  const player = new PcmPlayer(() => output);
  player.enable();
  return { output, player };
}

describe('PcmPlayer', () => {
  test('plays nothing until it is enabled, and opens its output once', () => {
    const output = new FakeOutput();
    let opened = 0;
    const player = new PcmPlayer(() => {
      opened += 1;
      return output;
    });
    player.play(chunk([0, 64]));
    expect(output.scheduled).toEqual([]);
    expect(player.getState()).toEqual({ speaking: false, chunks: 0 });
    player.enable();
    player.enable();
    expect([opened, output.resumed]).toEqual([1, 2]);
  });

  test('schedules each piece to start where the one before it ends', () => {
    const { output, player } = enabled();
    const changes: boolean[] = [];
    const stop = player.subscribe(() => {
      changes.push(player.getState().speaking);
    });
    // 0x4000 little-endian is half of full scale; 0xC000 is minus half.
    player.play(chunk([0, 64, 0, 192]));
    player.play(chunk([0, 64], { last: true }));
    expect(output.scheduled.map((entry) => entry.samples)).toEqual([[[0.5, -0.5]], [[0.5]]]);
    expect(output.scheduled[0]?.sampleRate).toBe(24_000);
    expect(output.scheduled[0]?.startAt).toBeCloseTo(10.05, 5);
    expect(output.scheduled[1]?.startAt).toBeCloseTo(10.05 + 2 / 24_000, 8);
    expect(player.getState()).toEqual({ speaking: true, chunks: 2 });

    output.scheduled[0]?.end();
    expect(player.getState().speaking).toBe(true);
    output.scheduled[1]?.end();
    expect(player.getState().speaking).toBe(false);
    expect(changes).toEqual([true, true, false]);
    stop();
    player.play(chunk([0, 64]));
    expect(changes.length).toBe(3);
  });

  test('a sample cut in two by the network is put back together', () => {
    const { output, player } = enabled();
    player.play(chunk([0, 64, 0]));
    player.play(chunk([192, 0, 64]));
    expect(output.scheduled.map((entry) => entry.samples)).toEqual([[[0.5]], [[-0.5, 0.5]]]);
    // A piece with less than one sample plays nothing; a new answer starts clean.
    player.play(chunk([7], { artifactId: 'speech-2' }));
    player.play(chunk([0, 64], { artifactId: 'speech-3' }));
    expect(output.scheduled.length).toBe(3);
    expect(output.scheduled[2]?.samples).toEqual([[0.5]]);
  });

  test('splits interleaved stereo into its two channels', () => {
    const { output, player } = enabled();
    player.play(chunk([0, 64, 0, 192, 0, 32, 0, 224], { channels: 2 }));
    expect(output.scheduled[0]?.samples).toEqual([
      [0.5, 0.25],
      [-0.5, -0.25],
    ]);
  });

  test('stop silences what is playing and forgets what was scheduled', () => {
    const { output, player } = enabled();
    player.play(chunk([0, 64]));
    player.stop();
    expect(output.scheduled[0]?.stopped).toBe(true);
    expect(player.getState().speaking).toBe(false);
    output.scheduled[0]?.end();
    output.currentTime = 20;
    player.enable();
    player.play(chunk([0, 64]));
    expect(output.scheduled[1]?.startAt).toBeCloseTo(20.05, 5);
  });

  test('after a stop, the rest of an answer still arriving is not played until enabled', () => {
    const { output, player } = enabled();
    player.play(chunk([0, 64]));
    player.stop();
    player.play(chunk([0, 64]));
    player.play(chunk([0, 64], { last: true }));
    expect(output.scheduled.length).toBe(1);
    expect(player.getState()).toEqual({ speaking: false, chunks: 1 });
    player.enable();
    player.play(chunk([0, 64], { artifactId: 'speech-2' }));
    expect(output.scheduled.length).toBe(2);
  });
});

/** A stand-in for the browser's `AudioContext`, recording how it is driven. */
class FakeAudioContext {
  static readonly made: FakeAudioContext[] = [];
  readonly log: string[] = [];
  readonly destination = 'speakers';
  readonly currentTime = 3;
  state = 'suspended';
  ended: (() => void) | null = null;

  constructor() {
    FakeAudioContext.made.push(this);
  }

  resume(): Promise<void> {
    this.state = 'running';
    this.log.push('resume');
    return Promise.resolve();
  }

  createBuffer(channels: number, frames: number, sampleRate: number): object {
    this.log.push(`buffer ${String(channels)}x${String(frames)}@${String(sampleRate)}`);
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      duration: frames / sampleRate,
      getChannelData: (channel: number) => data[channel],
      data,
    };
  }

  createBufferSource(): object {
    const { log } = this;
    return {
      buffer: null,
      connect: (destination: string): void => {
        log.push(`connect ${destination}`);
      },
      addEventListener: (type: string, listener: () => void): void => {
        log.push(`listen ${type}`);
        this.ended = listener;
      },
      start: (at: number): void => {
        log.push(`start ${String(at)}`);
      },
      stop: (): void => {
        log.push('stop');
      },
    };
  }
}

/** Runs `body` with `name` set on the global object, and puts back what was there. */
async function withGlobal(name: string, value: unknown, body: () => Promise<void>): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    await body();
  } finally {
    if (before === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, before);
    }
  }
}

describe('the browser audio output', () => {
  test('drives an AudioContext: resumes it, fills a buffer, connects, schedules, stops', async () => {
    await withGlobal('AudioContext', FakeAudioContext, () => {
      const output = webAudioOutput();
      const context = FakeAudioContext.made.at(-1);
      expect(output.currentTime).toBe(3);
      output.resume();
      output.resume();
      let ended = 0;
      const scheduled = output.schedule([Float32Array.from([0.5, -0.5])], 24_000, 3.05, () => {
        ended += 1;
      });
      expect(scheduled.duration).toBeCloseTo(2 / 24_000, 8);
      scheduled.stop();
      context?.ended?.();
      expect(ended).toBe(1);
      expect(context?.log).toEqual([
        'resume',
        'buffer 1x2@24000',
        'connect speakers',
        'listen ended',
        'start 3.05',
        'stop',
      ]);
      expect(output.schedule([], 24_000, 4, () => undefined).duration).toBe(0);
      return Promise.resolve();
    });
  });

  test('is what a player opens when it is given nothing else', async () => {
    await withGlobal('AudioContext', FakeAudioContext, () => {
      const before = FakeAudioContext.made.length;
      const player = new PcmPlayer();
      player.enable();
      player.play(chunk([0, 64]));
      expect(FakeAudioContext.made.length).toBe(before + 1);
      expect(player.getState().chunks).toBe(1);
      return Promise.resolve();
    });
  });
});

type Stream = MicStream & { readonly id: string };

/** An encoder that "records" `content` and reports it when stopped. */
function fakeEncoders(content: string, supported = 'audio/webm;codecs=opus') {
  const made: { mimeType: string | undefined; stream: string; started: boolean }[] = [];
  const encoder: NonNullable<RecorderScope<Stream>['encoder']> = {
    supports: (mimeType) => mimeType === supported,
    create: (stream, mimeType): MediaEncoder => {
      const entry = { mimeType, stream: stream.id, started: false };
      made.push(entry);
      const data: ((event: { data: Blob }) => void)[] = [];
      const stop: (() => void)[] = [];
      return {
        mimeType: mimeType ?? supported,
        addEventListener: (type: string, listener: (event: { data: Blob }) => void): void => {
          if (type === 'dataavailable') {
            data.push(listener);
          } else {
            stop.push(() => {
              listener({ data: new Blob([]) });
            });
          }
        },
        start: (): void => {
          entry.started = true;
        },
        stop: (): void => {
          for (const listener of data) {
            listener({ data: new Blob([content]) });
          }
          for (const listener of stop) {
            listener();
          }
        },
      };
    },
  };
  return { encoder, made };
}

function microphone(): { getUserMedia: () => Promise<Stream>; stopped: number[] } {
  const stopped: number[] = [];
  const stream: Stream = {
    id: 'mic-1',
    getTracks: () => [
      {
        stop: (): void => {
          stopped.push(1);
        },
      },
    ],
  };
  return { getUserMedia: () => Promise.resolve(stream), stopped };
}

async function problemOf(scope: RecorderScope<Stream>): Promise<string> {
  try {
    await startRecording(scope);
  } catch (error) {
    return error instanceof MicError ? error.problem : 'not a MicError';
  }
  return 'started';
}

describe('startRecording', () => {
  test('records with the first supported container and returns the recording as a file', async () => {
    const { encoder, made } = fakeEncoders('sound');
    const mic = microphone();
    const recording = await startRecording({ getUserMedia: mic.getUserMedia, encoder });
    expect(made).toEqual([{ mimeType: 'audio/webm;codecs=opus', stream: 'mic-1', started: true }]);
    const file = await recording.stop();
    expect(file.mediaType).toBe('audio/webm');
    expect(file.name).toBe('voice-message.webm');
    expect(new TextDecoder().decode(file.data)).toBe('sound');
    expect(mic.stopped).toEqual([1]);
  });

  test('takes another container when that is what the browser has, and names the file to match', async () => {
    const mp4 = fakeEncoders('sound', 'audio/mp4');
    const mic = microphone();
    const recording = await startRecording({
      getUserMedia: mic.getUserMedia,
      encoder: mp4.encoder,
    });
    expect(lastType(mp4)).toBe('audio/mp4');
    expect((await recording.stop()).name).toBe('voice-message.mp4');

    const unknown = fakeEncoders('sound', 'audio/x-odd');
    const other = await startRecording({
      getUserMedia: mic.getUserMedia,
      encoder: unknown.encoder,
    });
    expect(lastType(unknown)).toBeUndefined();
    expect((await other.stop()).name).toBe('voice-message.webm');

    const unnamed = fakeEncoders('sound', '');
    const last = await startRecording({ getUserMedia: mic.getUserMedia, encoder: unnamed.encoder });
    expect((await last.stop()).mediaType).toBe('audio/webm');
  });

  test('cancel stops the recording and releases the microphone', async () => {
    const mic = microphone();
    const recording = await startRecording({
      getUserMedia: mic.getUserMedia,
      encoder: fakeEncoders('sound').encoder,
    });
    recording.cancel();
    expect(mic.stopped).toEqual([1]);
  });

  test('an empty recording is a failure', async () => {
    const recording = await startRecording({
      getUserMedia: microphone().getUserMedia,
      encoder: fakeEncoders('').encoder,
    });
    const outcome = await recording.stop().catch((error: unknown) => error);
    expect(outcome instanceof MicError && outcome.problem).toBe('failed');
  });

  test('names every way the microphone can be missing or refused', async () => {
    const { encoder } = fakeEncoders('sound');
    expect(await problemOf({ encoder })).toBe('unavailable');
    expect(await problemOf({ getUserMedia: microphone().getUserMedia })).toBe('unavailable');
    const cases = {
      NotAllowedError: 'denied',
      SecurityError: 'denied',
      NotFoundError: 'unavailable',
      NotSupportedError: 'unavailable',
      OverconstrainedError: 'unavailable',
      AbortError: 'failed',
    };
    for (const [name, problem] of Object.entries(cases)) {
      const getUserMedia = (): Promise<Stream> => Promise.reject(new DOMException('no', name));
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      expect(await problemOf({ getUserMedia, encoder })).toBe(problem);
    }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error is the case
    const plain = (): Promise<Stream> => Promise.reject('just a string');
    expect(await problemOf({ getUserMedia: plain, encoder })).toBe('failed');
  });

  test('an encoder that cannot start releases the microphone and is a failure', async () => {
    const mic = microphone();
    const scope: RecorderScope<Stream> = {
      getUserMedia: mic.getUserMedia,
      encoder: {
        supports: () => false,
        create: () => {
          throw new Error('no encoder');
        },
      },
    };
    expect(await problemOf(scope)).toBe('failed');
    expect(mic.stopped).toEqual([1]);
  });
});

/** A stand-in for the browser's `MediaRecorder`. */
class FakeMediaRecorder {
  static readonly made: { stream: unknown; options: unknown }[] = [];
  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm';
  }

  readonly mimeType = 'audio/webm';
  readonly #listeners = new Map<string, ((event: { data: Blob }) => void)[]>();

  constructor(stream: unknown, options: unknown) {
    FakeMediaRecorder.made.push({ stream, options });
  }

  addEventListener(type: string, listener: (event: { data: Blob }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  start(): void {
    this.#listeners.set('started', []);
  }

  stop(): void {
    for (const type of ['dataavailable', 'stop']) {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener({ data: new Blob(['browser sound']) });
      }
    }
  }
}

describe('recording from the browser', () => {
  test('uses getUserMedia and MediaRecorder as the browser has them', async () => {
    const asked: unknown[] = [];
    const stream = { getTracks: () => [] };
    const navigator = {
      mediaDevices: {
        getUserMedia: (constraints: unknown) => {
          asked.push(constraints);
          return Promise.resolve(stream);
        },
      },
    };
    await withGlobal('navigator', navigator, async () => {
      await withGlobal('MediaRecorder', FakeMediaRecorder, async () => {
        const recording = await recordFromBrowser();
        const file = await recording.stop();
        expect(new TextDecoder().decode(file.data)).toBe('browser sound');
      });
    });
    expect(asked).toEqual([{ audio: true }]);
    expect(FakeMediaRecorder.made).toEqual([{ stream, options: { mimeType: 'audio/webm' } }]);
  });

  test('says the microphone is unavailable where the browser has no API for it', async () => {
    await withGlobal('navigator', {}, async () => {
      await withGlobal('MediaRecorder', undefined, async () => {
        const outcome = await recordFromBrowser().catch((error: unknown) => error);
        expect(outcome instanceof MicError && outcome.problem).toBe('unavailable');
      });
    });
  });
});

function lastType(encoders: ReturnType<typeof fakeEncoders>): string | undefined {
  return encoders.made.at(-1)?.mimeType;
}
