/**
 * The A2A SDK client is fetch-based and runs in a browser, but it names Node's `Buffer`
 * global for binary (`raw`) parts: `Buffer.from(base64, 'base64')` to decode one,
 * `Buffer.from(bytes).toString('base64')` to encode one, and `Buffer.isBuffer` to tell
 * bytes from a JSON object. This is that much of `Buffer` — bytes in and out of base64 —
 * so images and audio travel in a browser exactly as they do under Node.
 */
import { fromBase64, toBase64 } from '../../../bytes.ts';

/** Bytes that know their base64 form: what the stand-in's `from` returns. */
export interface BrowserBuffer extends Uint8Array {
  /** The bytes as base64 when asked for it, as UTF-8 text otherwise. */
  toString(encoding?: string): string;
}

/** The slice of `Buffer` the SDK client touches. */
export interface BufferShim {
  isBuffer(value: unknown): boolean;
  from(value: string | ArrayLike<number>, encoding?: string): BrowserBuffer;
}

/** Every buffer the stand-in made: how `isBuffer` knows its own. */
const made = new WeakSet();

function browserBuffer(bytes: ArrayLike<number>): BrowserBuffer {
  const buffer: Uint8Array = Uint8Array.from(bytes);
  const withText = Object.assign(buffer, {
    toString: (encoding?: string): string =>
      encoding === 'base64' ? toBase64(buffer) : new TextDecoder().decode(buffer),
  });
  made.add(withText);
  return withText;
}

/** The stand-in installed by {@link installBufferShim}. */
export const bufferShim: BufferShim = {
  isBuffer: (value: unknown): boolean =>
    typeof value === 'object' && value !== null && made.has(value),
  from: (value, encoding): BrowserBuffer => {
    if (typeof value !== 'string') {
      return browserBuffer(value);
    }
    return browserBuffer(
      encoding === 'base64' ? fromBase64(value) : new TextEncoder().encode(value),
    );
  },
};

/** Installs the stand-in where there is no `Buffer`; a runtime that has one keeps it. */
export function installBufferShim(scope: object = globalThis): void {
  if (Reflect.get(scope, 'Buffer') === undefined) {
    Reflect.set(scope, 'Buffer', bufferShim);
  }
}
