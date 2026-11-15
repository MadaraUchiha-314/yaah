/**
 * Recording a voice message in the browser: the microphone through `getUserMedia`, the
 * encoding through `MediaRecorder`. Every way this can fail is one of three problems the
 * page can name to the user — and none of them touches text input.
 */
import type { TurnFile } from '../../../session.ts';

/**
 * Why there is no recording: the browser has no microphone API or no microphone
 * (`unavailable`), the user or a policy said no (`denied`), or it broke (`failed`).
 */
export type MicProblem = 'unavailable' | 'denied' | 'failed';

/** Recording could not start, or produced nothing. */
export class MicError extends Error {
  readonly problem: MicProblem;

  constructor(problem: MicProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** A recording under way. */
export interface Recording {
  /** Ends the recording and returns it. */
  stop(): Promise<TurnFile>;
  /** Ends the recording and drops it. */
  cancel(): void;
}

/** The slice of a `MediaStream` a recording uses. */
export interface MicStream {
  getTracks(): readonly { stop(): void }[];
}

/** The slice of a `MediaRecorder` a recording uses. */
export interface MediaEncoder {
  /** The container and codec it writes, as the browser reports it. */
  readonly mimeType: string;
  addEventListener(type: 'dataavailable', listener: (event: { readonly data: Blob }) => void): void;
  addEventListener(type: 'stop', listener: () => void): void;
  start(): void;
  stop(): void;
}

/** The browser APIs a recording needs; tests pass their own. */
export interface RecorderScope<S extends MicStream = MicStream> {
  /** Asks for the microphone. Absent when the browser has no API for it. */
  readonly getUserMedia?: (() => Promise<S>) | undefined;
  /** Absent when the browser has no `MediaRecorder`. */
  readonly encoder?:
    | {
        supports(mimeType: string): boolean;
        /** Creates an encoder writing `mimeType`, or the browser's default without one. */
        create(stream: S, mimeType: string | undefined): MediaEncoder;
      }
    | undefined;
}

/** The containers asked for, in order of preference; the browser's default otherwise. */
const TYPES: readonly string[] = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
};

/** What this browser offers. */
export function browserScope(): RecorderScope<MediaStream> {
  const devices: MediaDevices | undefined = globalThis.navigator.mediaDevices;
  const hasEncoder = typeof MediaRecorder !== 'undefined';
  return {
    getUserMedia:
      devices === undefined
        ? undefined
        : (): Promise<MediaStream> => devices.getUserMedia({ audio: true }),
    encoder: hasEncoder
      ? {
          supports: (mimeType: string): boolean => MediaRecorder.isTypeSupported(mimeType),
          create: (stream: MediaStream, mimeType: string | undefined): MediaEncoder =>
            new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType }),
        }
      : undefined,
  };
}

/** The errors a browser raises when it has no microphone, or cannot capture audio at all. */
const MISSING: ReadonlySet<string> = new Set([
  'NotFoundError',
  'NotSupportedError',
  'OverconstrainedError',
]);

function problemOf(error: unknown): MicProblem {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'denied';
  }
  return MISSING.has(name) ? 'unavailable' : 'failed';
}

function release(stream: MicStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/** The recording as a file: the container without its codec parameter, and a name to match. */
async function toFile(chunks: readonly Blob[], type: string): Promise<TurnFile> {
  const base = (type.split(';')[0] ?? '').trim();
  const mediaType = base === '' ? 'audio/webm' : base;
  const data = new Uint8Array(await new Blob([...chunks], { type: mediaType }).arrayBuffer());
  if (data.length === 0) {
    throw new MicError('failed');
  }
  return { mediaType, name: `voice-message.${EXTENSIONS[mediaType] ?? 'webm'}`, data };
}

/** Starts encoding `stream`; what it writes is collected in `chunks`. */
function encode<S extends MicStream>(
  encoders: NonNullable<RecorderScope<S>['encoder']>,
  stream: S,
  chunks: Blob[],
): MediaEncoder {
  try {
    const mimeType = TYPES.find((type) => encoders.supports(type));
    const encoder = encoders.create(stream, mimeType);
    encoder.addEventListener('dataavailable', (event: { readonly data: Blob }) => {
      chunks.push(event.data);
    });
    encoder.start();
    return encoder;
  } catch {
    release(stream);
    throw new MicError('failed');
  }
}

/**
 * Asks for the microphone and starts recording.
 *
 * @param scope The browser's APIs unless a test passes its own.
 * @throws MicError when there is no microphone API, permission is denied, or recording
 *   cannot start.
 */
export async function startRecording<S extends MicStream>(
  scope: RecorderScope<S>,
): Promise<Recording> {
  const { getUserMedia, encoder: encoders } = scope;
  if (getUserMedia === undefined || encoders === undefined) {
    throw new MicError('unavailable');
  }
  let stream: S;
  try {
    stream = await getUserMedia();
  } catch (error) {
    throw new MicError(problemOf(error));
  }
  const chunks: Blob[] = [];
  const encoder = encode(encoders, stream, chunks);
  return {
    stop: (): Promise<TurnFile> =>
      new Promise((resolve, reject) => {
        encoder.addEventListener('stop', () => {
          release(stream);
          toFile(chunks, encoder.mimeType).then(resolve, reject);
        });
        encoder.stop();
      }),
    cancel: (): void => {
      encoder.stop();
      release(stream);
    },
  };
}

/** Records from this browser's microphone. */
export function recordFromBrowser(): Promise<Recording> {
  return startRecording(browserScope());
}
