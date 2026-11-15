/**
 * Bytes to base64 and back, with what every runtime a surface runs on has: `btoa` and
 * `atob`. No `Buffer`, so the same code runs in a browser and in a terminal.
 */

/** How many bytes are turned into characters at a time: well under any argument limit. */
const SLICE = 0x80_00;

/** The base64 form of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += SLICE) {
    binary += String.fromCodePoint(...bytes.subarray(start, start + SLICE));
  }
  return btoa(binary);
}

/** The bytes a base64 text stands for. */
export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character: string) => character.codePointAt(0) ?? 0);
}

/** A `data:` URL holding `bytes` as content of type `mediaType`. */
export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${toBase64(bytes)}`;
}
