/**
 * Recording a voice message from a terminal. There is no microphone API here, so the
 * sound is captured by a recorder program the system already has: `arecord`, `pw-record`
 * or `ffmpeg`, whichever is found first on `PATH`. It is started directly — never through
 * a shell — with a fixed list of arguments; nothing a user or an agent wrote reaches it.
 * It writes 16 kHz mono 16-bit PCM to its standard output, which is kept in memory, up to
 * a fixed size, and wrapped as a WAV file when the recording ends.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { TurnFile } from '../../session.ts';

/** A recorder program and the arguments that make it write PCM to standard output. */
export interface RecorderCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The slice of a child process a recording uses. */
export interface RecorderProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown } | null;
  on(event: 'spawn' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Starts a program with arguments, with no shell in between. */
export type Spawner = (command: string, args: readonly string[]) => RecorderProcess;

/** What {@link VoiceRecorder} can be given instead of the system's own. */
export interface RecorderOptions {
  readonly spawn?: Spawner | undefined;
  /** Whether a program is on `PATH`. */
  readonly available?: ((command: string) => boolean) | undefined;
  /** The platform, which decides how `ffmpeg` names the microphone. */
  readonly platform?: string | undefined;
  /** The most audio kept, in bytes; the recording ends itself when it is reached. */
  readonly maxBytes?: number | undefined;
}

/** How a recording started, or why it did not. */
export type StartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-recorder' }
  | { readonly ok: false; readonly reason: 'spawn-failed'; readonly message: string };

const SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;
/** About two and a half minutes of 16 kHz mono 16-bit audio. */
const DEFAULT_MAX_BYTES = 5_000_000;

/** The recorders tried, in order, with the arguments each needs. */
export function recorderCommands(platform: string): readonly RecorderCommand[] {
  const rate = String(SAMPLE_RATE);
  const microphone =
    platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : ['-f', 'pulse', '-i', 'default'];
  return [
    { command: 'arecord', args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', rate, '-c', '1', '-'] },
    { command: 'pw-record', args: ['--rate', rate, '--channels', '1', '--format', 's16', '-'] },
    {
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        ...microphone,
        '-ac',
        '1',
        '-ar',
        rate,
        '-f',
        's16le',
        '-',
      ],
    },
  ];
}

function onPath(command: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((directory: string) => {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return directory !== '';
    } catch {
      return false;
    }
  });
}

function systemSpawn(command: string, args: readonly string[]): RecorderProcess {
  return spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
}

/** The samples of what a recorder wrote: after a WAV header when it wrote one, else all of it. */
export function pcmOf(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (!text.startsWith('RIFF')) {
    return bytes;
  }
  const data = text.indexOf('data');
  return data === -1 ? bytes.subarray(WAV_HEADER_BYTES) : bytes.subarray(data + 8);
}

/** A WAV file holding `pcm`: 16 kHz, mono, 16-bit. */
export function wavOf(pcm: Uint8Array): Uint8Array {
  const file = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(file.buffer);
  const ascii = (offset: number, text: string): void => {
    file.set(new TextEncoder().encode(text), offset);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  file.set(pcm, WAV_HEADER_BYTES);
  return file;
}

/** One microphone recording at a time, made by a recorder program. */
export class VoiceRecorder {
  readonly #options: RecorderOptions;
  #process: RecorderProcess | null = null;
  #chunks: Uint8Array[] = [];
  #bytes = 0;
  #closed: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions = {}) {
    this.#options = options;
  }

  /** Whether a recording is under way. */
  get recording(): boolean {
    return this.#process !== null;
  }

  /** Starts recording with the first recorder found. Resolves once it runs, or cannot. */
  async start(): Promise<StartOutcome> {
    const available = this.#options.available ?? onPath;
    const found = recorderCommands(this.#options.platform ?? process.platform).find((recorder) =>
      available(recorder.command),
    );
    if (found === undefined) {
      return { ok: false, reason: 'no-recorder' };
    }
    try {
      const child = (this.#options.spawn ?? systemSpawn)(found.command, found.args);
      const outcome = await this.#watch(child);
      this.#process = outcome.ok ? child : null;
      return outcome;
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', message: messageOf(error) };
    }
  }

  /** Ends the recording. Returns it as a WAV file, or null when nothing was captured. */
  async stop(): Promise<TurnFile | null> {
    const child = this.#process;
    this.#process = null;
    if (child === null) {
      return null;
    }
    child.kill('SIGTERM');
    await this.#closed;
    const captured = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      captured.set(chunk, offset);
      offset += chunk.length;
    }
    this.#chunks = [];
    this.#bytes = 0;
    const pcm = pcmOf(captured);
    return pcm.length === 0
      ? null
      : { mediaType: 'audio/wav', name: 'voice-message.wav', data: wavOf(pcm) };
  }

  /** Collects what `child` writes, and resolves when it is running or has failed to start. */
  #watch(child: RecorderProcess): Promise<StartOutcome> {
    this.#chunks = [];
    this.#bytes = 0;
    const limit = this.#options.maxBytes ?? DEFAULT_MAX_BYTES;
    child.stdout?.on('data', (chunk: Uint8Array) => {
      const room = limit - this.#bytes;
      if (room <= 0) {
        // The size limit is reached: stop the recorder; what is kept is the recording.
        child.kill('SIGTERM');
        return;
      }
      const kept = chunk.subarray(0, room);
      this.#chunks.push(kept);
      this.#bytes += kept.length;
    });
    this.#closed = new Promise((resolve: () => void) => {
      child.on('close', resolve);
      child.on('error', () => {
        resolve();
      });
    });
    return new Promise((resolve: (outcome: StartOutcome) => void) => {
      child.on('spawn', () => {
        resolve({ ok: true });
      });
      child.on('error', (error: Error) => {
        resolve({ ok: false, reason: 'spawn-failed', message: error.message });
      });
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
