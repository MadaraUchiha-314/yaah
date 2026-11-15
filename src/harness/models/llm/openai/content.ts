/**
 * Rendering rules both OpenAI wire formats (Responses and Chat Completions) share: how a
 * content part becomes text or an image URL, how a tool result reads to the model, and
 * how untyped JSON from the wire becomes a {@link Json} value.
 */
import type { Json } from '../../../../kernel/json.ts';
import { t } from '../../../../kernel/strings.ts';
import type { ContentPart, ToolResult } from '../../../core/types.ts';
import type { LlmContent, LlmMessage } from '../types.ts';

/** A `fetch` implementation, as the OpenAI SDK accepts it. Tests inject one to replay HTTP. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A file content part. */
export type FilePart = Extract<ContentPart, { type: 'file' }>;

/** A tool-result block of a `tool` message. */
export type ToolResultBlock = Extract<LlmContent, { type: 'tool-result' }>;

/**
 * Copies a value that came off the wire into a {@link Json} value. Anything JSON cannot
 * hold (`undefined`, functions, non-finite numbers) is dropped or becomes `null`, so the
 * result always survives persistence unchanged.
 */
export function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => toJson(item));
  }
  if (typeof value === 'object') {
    const copy: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        copy[key] = toJson(item);
      }
    }
    return copy;
  }
  return null;
}

/**
 * Parses the JSON text of a tool call's arguments. Empty text means "no arguments" and
 * yields `{}`. Returns `undefined` when the text is not JSON.
 */
export function parseArguments(text: string): Json | undefined {
  if (text.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return toJson(parsed);
  } catch {
    return undefined;
  }
}

/** Whether a file part is an image. */
export function isImage(part: FilePart): boolean {
  return part.mediaType.startsWith('image/');
}

/** The URL a file part is sent as: its own URL, or a `data:` URL of its base64 content. */
export function fileUrl(part: FilePart): string {
  return part.source.kind === 'url'
    ? part.source.url
    : `data:${part.mediaType};base64,${part.source.data}`;
}

/** The text a part is sent as: text as is, data as JSON. `null` for a file. */
export function partText(part: ContentPart): string | null {
  if (part.type === 'text') {
    return part.text;
  }
  return part.type === 'data' ? JSON.stringify(part.data) : null;
}

/** The text parts of a message, joined by newlines; every other block is ignored. */
export function messageText(content: readonly LlmContent[]): string {
  return content
    .flatMap((block: LlmContent) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/**
 * A tool result as the model reads it: the text and data parts joined by newlines, or
 * `Error (code): message` for a failure. Files are not part of the text.
 */
export function resultText(result: ToolResult): string {
  if (!result.ok) {
    return t('llm.tool-error', { code: result.error.code, message: result.error.message });
  }
  return result.content.flatMap((part: ContentPart) => partText(part) ?? []).join('\n');
}

/**
 * The tool results of one `tool` message, in the order the model made the calls — the
 * order of the `tool-call` blocks earlier in `messages` — whatever order they finished in.
 * A result whose call is not in `messages` keeps its place after the known ones.
 */
export function resultsInCallOrder(
  message: LlmMessage,
  messages: readonly LlmMessage[],
): readonly ToolResultBlock[] {
  const order = new Map<string, number>();
  for (const block of messages.flatMap((each: LlmMessage) => each.content)) {
    if (block.type === 'tool-call' && !order.has(block.call.id)) {
      order.set(block.call.id, order.size);
    }
  }
  const rank = (block: ToolResultBlock): number =>
    order.get(block.callId) ?? Number.MAX_SAFE_INTEGER;
  return message.content
    .flatMap((block: LlmContent) => (block.type === 'tool-result' ? [block] : []))
    .toSorted((a: ToolResultBlock, b: ToolResultBlock) => rank(a) - rank(b));
}
