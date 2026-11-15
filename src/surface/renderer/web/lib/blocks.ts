/**
 * How a flat transcript becomes what the page lays out: what the agent did between two
 * things the user said is one turn, and tool calls next to each other are one group.
 */
import type { TranscriptItem } from '../../../view.ts';

/** A tool call of the transcript. */
export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** One piece of an agent's turn. */
export type TurnPart =
  | { readonly kind: 'tools'; readonly id: string; readonly calls: readonly ToolItem[] }
  | Extract<TranscriptItem, { kind: 'agent' | 'ask' }>;

/** One block of the conversation, top to bottom. */
export type Block =
  | Extract<TranscriptItem, { kind: 'user' | 'note' }>
  | { readonly kind: 'turn'; readonly id: string; readonly parts: readonly TurnPart[] };

function withPart(parts: readonly TurnPart[], item: TurnPart | ToolItem): TurnPart[] {
  if (item.kind !== 'tool') {
    return [...parts, item];
  }
  const last = parts.at(-1);
  if (last?.kind === 'tools') {
    return [...parts.slice(0, -1), { ...last, calls: [...last.calls, item] }];
  }
  return [...parts, { kind: 'tools', id: `tools-${item.id}`, calls: [item] }];
}

/** Groups transcript items into blocks. */
export function toBlocks(items: readonly TranscriptItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'note') {
      blocks.push(item);
    } else {
      const last = blocks.at(-1);
      if (last?.kind === 'turn') {
        blocks[blocks.length - 1] = { ...last, parts: withPart(last.parts, item) };
      } else {
        blocks.push({ kind: 'turn', id: `turn-${item.id}`, parts: withPart([], item) });
      }
    }
  }
  return blocks;
}
