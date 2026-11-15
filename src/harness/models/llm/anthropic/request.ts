/**
 * Maps a provider-agnostic {@link LlmRequest} onto the body of Anthropic's Messages API.
 * Pure: no I/O, no client. The streaming half lives in `events.ts`.
 */
import type Anthropic from '@anthropic-ai/sdk';

import { isJsonObject } from '../../../../kernel/json.ts';
import { t } from '../../../../kernel/strings.ts';
import type { ContentPart, ProviderOpaque, ToolResult } from '../../../core/types.ts';
import type { LlmCapabilities, LlmContent, LlmMessage, LlmRequest } from '../types.ts';
import { LlmError } from '../types.ts';

/** The provider name carried by errors and by opaque reasoning blocks. */
export const PROVIDER = 'anthropic';

/** The image media types the API takes inline. */
export const IMAGE_MEDIA_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

/** The most cache breakpoints one request may carry. */
const MAX_BREAKPOINTS = 4;

type TextBlock = Anthropic.TextBlockParam;
type ResultPart = TextBlock | Anthropic.ImageBlockParam;
type Block =
  | ResultPart
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam;
type ImageMediaType = Anthropic.Base64ImageSource['media_type'];
type Effort = NonNullable<Anthropic.OutputConfig['effort']>;

/** One message of the body, with the role it came from so tool messages can be merged. */
interface Draft {
  readonly role: 'user' | 'assistant';
  readonly fromTool: boolean;
  readonly content: Block[];
}

function isImageMediaType(mediaType: string): mediaType is ImageMediaType {
  return (
    mediaType === 'image/jpeg' ||
    mediaType === 'image/png' ||
    mediaType === 'image/gif' ||
    mediaType === 'image/webp'
  );
}

function isEffort(effort: string): effort is Effort {
  return (
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
  );
}

function unsupported(model: string, mediaType: string): LlmError {
  return new LlmError(
    PROVIDER,
    model,
    false,
    t('llm.error.unsupported-content', { provider: PROVIDER, model, mediaType }),
  );
}

function imageBlock(
  part: Extract<ContentPart, { type: 'file' }>,
  model: string,
): Anthropic.ImageBlockParam {
  const { mediaType, source } = part;
  if (source.kind === 'url' && mediaType.startsWith('image/')) {
    return { type: 'image', source: { type: 'url', url: source.url } };
  }
  if (source.kind === 'base64' && isImageMediaType(mediaType)) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: source.data } };
  }
  throw unsupported(model, mediaType);
}

/** Null for an empty text part: the API rejects empty text blocks. */
function partBlock(part: ContentPart, model: string): ResultPart | null {
  if (part.type === 'text') {
    return part.text === '' ? null : { type: 'text', text: part.text };
  }
  if (part.type === 'data') {
    return { type: 'text', text: JSON.stringify(part.data) };
  }
  return imageBlock(part, model);
}

function resultBlock(
  callId: string,
  result: ToolResult,
  model: string,
): Anthropic.ToolResultBlockParam {
  if (!result.ok) {
    const text = `${result.error.code}: ${result.error.message}`;
    return {
      type: 'tool_result',
      tool_use_id: callId,
      is_error: true,
      content: [{ type: 'text', text }],
    };
  }
  const content = result.content.flatMap((part: ContentPart) => partBlock(part, model) ?? []);
  if (content.length === 0 && result.structured !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(result.structured) });
  }
  return content.length === 0
    ? { type: 'tool_result', tool_use_id: callId }
    : { type: 'tool_result', tool_use_id: callId, content };
}

/**
 * A reasoning block exactly as Anthropic returned it. Null for another provider's block,
 * which this API cannot read.
 */
function replayedBlock(opaque: ProviderOpaque): Block | null {
  const { data } = opaque;
  if (opaque.provider !== PROVIDER || !isJsonObject(data)) {
    return null;
  }
  const { type, thinking, signature, data: payload } = data;
  if (type === 'thinking' && typeof thinking === 'string' && typeof signature === 'string') {
    return { ...data, type, thinking, signature };
  }
  if (type === 'redacted_thinking' && typeof payload === 'string') {
    return { ...data, type, data: payload };
  }
  return null;
}

function contentBlock(content: LlmContent, model: string): Block | null {
  if (content.type === 'tool-call') {
    const { id, name, args } = content.call;
    return { type: 'tool_use', id, name, input: isJsonObject(args) ? args : {} };
  }
  if (content.type === 'tool-result') {
    return resultBlock(content.callId, content.result, model);
  }
  if (content.type === 'reasoning') {
    return replayedBlock(content.opaque);
  }
  return partBlock(content, model);
}

/** Marks the last block of `blocks` that may carry a cache breakpoint. */
function markBreakpoint(blocks: readonly Block[]): void {
  const last = blocks.findLast(
    (block: Block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
  );
  if (last !== undefined) {
    last.cache_control = { type: 'ephemeral' };
  }
}

/** Puts the results of one turn in the order of the calls they answer, ahead of other blocks. */
function orderResults(drafts: readonly Draft[]): void {
  for (const [index, draft] of drafts.entries()) {
    const previous = drafts[index - 1];
    if (draft.role === 'user' && previous?.role === 'assistant') {
      const calls = previous.content.flatMap((block: Block) =>
        block.type === 'tool_use' ? [block.id] : [],
      );
      const rank = (block: Block): number => {
        if (block.type !== 'tool_result') {
          return calls.length + 1;
        }
        const position = calls.indexOf(block.tool_use_id);
        return position === -1 ? calls.length : position;
      };
      draft.content.sort((a: Block, b: Block) => rank(a) - rank(b));
    }
  }
}

interface Mapped {
  readonly system: TextBlock[];
  readonly drafts: Draft[];
  /** Per message with `cacheBoundary`, its own blocks, in prompt order. */
  readonly boundaries: Block[][];
}

function mapMessages(messages: readonly LlmMessage[], model: string): Mapped {
  const system: TextBlock[] = [];
  const drafts: Draft[] = [];
  const systemBoundaries: Block[][] = [];
  const boundaries: Block[][] = [];
  for (const message of messages) {
    const blocks = message.content.flatMap(
      (content: LlmContent) => contentBlock(content, model) ?? [],
    );
    if (message.role === 'system') {
      const texts = blocks.filter((block: Block) => block.type === 'text');
      system.push(...texts);
      if (message.cacheBoundary === true) {
        systemBoundaries.push(texts);
      }
    } else if (blocks.length > 0) {
      const fromTool = message.role === 'tool';
      const last = drafts.at(-1);
      if (fromTool && last?.fromTool === true) {
        last.content.push(...blocks);
      } else {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        drafts.push({ role, fromTool, content: [...blocks] });
      }
      if (message.cacheBoundary === true) {
        boundaries.push(blocks);
      }
    }
  }
  return { system, drafts, boundaries: [...systemBoundaries, ...boundaries] };
}

/**
 * Builds the Messages API body for `request`.
 *
 * Invariants:
 * - System messages become top-level `system` text blocks, one per text part.
 * - Consecutive `tool` messages become ONE user message whose `tool_result` blocks are in
 *   the order of the `tool_use` blocks they answer.
 * - Anthropic reasoning blocks are sent back unchanged, in place; other providers' are
 *   dropped.
 * - At most four cache breakpoints are set: the last four messages with `cacheBoundary`.
 * - `effort` is sent only when the model lists it in `capabilities.efforts`.
 * - `tool_choice` is never set.
 *
 * @throws LlmError (not retryable) for a file part the API cannot take: anything but an
 *   image by URL, or a base64 JPEG, PNG, GIF or WebP.
 */
export function buildParams(
  request: LlmRequest,
  model: string,
  capabilities: LlmCapabilities,
): Anthropic.MessageCreateParamsStreaming {
  const { system, drafts, boundaries } = mapMessages(request.messages, model);
  orderResults(drafts);
  for (const blocks of boundaries.slice(-MAX_BREAKPOINTS)) {
    markBreakpoint(blocks);
  }
  const params: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: capabilities.maxOutput,
    stream: true,
    messages: drafts.map((draft: Draft) => ({ role: draft.role, content: draft.content })),
  };
  if (system.length > 0) {
    params.system = system;
  }
  if (request.tools.length > 0) {
    params.tools = request.tools.map((tool: LlmRequest['tools'][number]) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: 'object' },
    }));
  }
  const { effort } = request;
  if (effort !== undefined && isEffort(effort) && capabilities.efforts.includes(effort)) {
    params.output_config = { effort };
  }
  return params;
}
