/** Reading a model's reply as it streams: through the turn extensions, into message parts. */
import type { ContentPart } from './types.ts';
import type { ReplyPiece, ReplyStream } from './steps.ts';

/** Gathers a reply's pieces into message parts, merging text that belongs together. */
export class ReplyParts {
  readonly parts: ContentPart[] = [];
  readonly #emit: (text: string) => void;

  constructor(emit: (text: string) => void) {
    this.#emit = emit;
  }

  add(pieces: readonly ReplyPiece[]): void {
    for (const piece of pieces) {
      const last = this.parts.at(-1);
      if (piece.type === 'data') {
        this.parts.push({ type: 'data', mediaType: piece.mediaType, data: piece.data });
      } else if (piece.text !== '') {
        this.#emit(piece.text);
        if (last?.type === 'text') {
          this.parts[this.parts.length - 1] = { type: 'text', text: last.text + piece.text };
        } else {
          this.parts.push({ type: 'text', text: piece.text });
        }
      }
    }
  }
}

/** Passes text through each turn extension's reader in turn. */
export function readThrough(
  streams: readonly ReplyStream[],
  text: string | null,
): readonly ReplyPiece[] {
  let pieces: readonly ReplyPiece[] = text === null ? [] : [{ type: 'text', text }];
  for (const stream of streams) {
    const next: ReplyPiece[] = [];
    for (const piece of pieces) {
      next.push(...(piece.type === 'text' ? stream.feed(piece.text) : [piece]));
    }
    if (text === null) {
      next.push(...stream.close());
    }
    pieces = next;
  }
  return pieces;
}
