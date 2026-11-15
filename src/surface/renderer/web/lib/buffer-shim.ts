/**
 * The A2A SDK client is fetch-based and runs in a browser, but it names Node's `Buffer`
 * global in two places: to tell a JSON object from bytes, and to carry binary (`raw`)
 * parts. The chat sends and shows text and A2UI data only, so this gives the SDK just
 * enough: nothing is ever a Buffer, and bytes it decodes stay a `Uint8Array`.
 */

/** The slice of `Buffer` the SDK client touches on the paths the chat uses. */
export interface BufferShim {
  isBuffer(value: unknown): boolean;
  from(value: string | ArrayLike<number>, encoding?: string): Uint8Array;
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);
}

/** The stand-in installed by {@link installBufferShim}. */
export const bufferShim: BufferShim = {
  isBuffer: (): boolean => false,
  from: (value, encoding): Uint8Array => {
    if (typeof value !== 'string') {
      return Uint8Array.from(value);
    }
    return encoding === 'base64' ? decodeBase64(value) : new TextEncoder().encode(value);
  },
};

/** Installs the stand-in where there is no `Buffer`; a runtime that has one keeps it. */
export function installBufferShim(scope: object = globalThis): void {
  if (Reflect.get(scope, 'Buffer') === undefined) {
    Reflect.set(scope, 'Buffer', bufferShim);
  }
}
