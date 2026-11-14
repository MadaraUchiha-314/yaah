/**
 * Renders an {@link LlmRequest} as a Responses API request.
 *
 * The request is stateless (`store: false`): the whole conversation is sent every time,
 * and the model's reasoning travels with it as encrypted reasoning items that are sent
 * back exactly as they were received.
 */
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';

import type { ContentPart } from '../../../core/types.ts';
import type { LlmContent, LlmMessage, LlmRequest, ToolDeclaration } from '../types.ts';
import type { FilePart, ToolResultBlock } from './content.ts';
import { fileUrl, isImage, partText, resultText, resultsInCallOrder } from './content.ts';

/** The `provider` of the opaque data this provider emits and accepts back. */
export const OPENAI = 'openai';

const EFFORTS: readonly NonNullable<ReasoningEffort>[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function isReasoningItem(data: unknown): data is ResponseReasoningItem {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'reasoning' &&
    'id' in data &&
    typeof data.id === 'string' &&
    'summary' in data &&
    Array.isArray(data.summary)
  );
}

function inputFile(part: FilePart): ResponseInputContent {
  const named = part.name === undefined ? {} : { filename: part.name };
  return part.source.kind === 'url'
    ? { type: 'input_file', ...named, file_url: part.source.url }
    : { type: 'input_file', ...named, file_data: fileUrl(part) };
}

function inputContent(part: ContentPart): ResponseInputContent {
  if (part.type !== 'file') {
    return { type: 'input_text', text: partText(part) ?? '' };
  }
  return isImage(part)
    ? { type: 'input_image', detail: 'auto', image_url: fileUrl(part) }
    : inputFile(part);
}

function isContentPart(block: LlmContent): block is ContentPart {
  return block.type === 'text' || block.type === 'file' || block.type === 'data';
}

/** A system or user message: its content parts; blocks that belong to other roles are ignored. */
function inputMessage(role: 'system' | 'user', message: LlmMessage): ResponseInputItem[] {
  const content = message.content
    .filter((block: LlmContent) => isContentPart(block))
    .map((part: ContentPart) => inputContent(part));
  return content.length === 0 ? [] : [{ role, content }];
}

/** An assistant turn: reasoning items, text and function calls, in the order they were produced. */
function assistantItems(message: LlmMessage): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      items.push({ role: 'assistant', content: block.text });
    } else if (block.type === 'tool-call') {
      items.push({
        type: 'function_call',
        call_id: block.call.id,
        name: block.call.name,
        arguments: JSON.stringify(block.call.args),
      });
    } else if (block.type === 'reasoning' && block.opaque.provider === OPENAI) {
      // Another provider's reasoning means nothing here, and a malformed item is rejected
      // By the API, so both are left out.
      const item: unknown = block.opaque.data;
      if (isReasoningItem(item)) {
        items.push(item);
      }
    }
  }
  return items;
}

function outputItem(part: ContentPart): ResponseFunctionCallOutputItem[] {
  if (part.type !== 'file') {
    return [{ type: 'input_text', text: partText(part) ?? '' }];
  }
  return isImage(part) ? [{ type: 'input_image', detail: 'auto', image_url: fileUrl(part) }] : [];
}

/** A tool result: plain text, or a list of parts when the result carries an image. */
function toolOutput(block: ToolResultBlock): ResponseInputItem {
  const { result } = block;
  const hasImage =
    result.ok && result.content.some((part: ContentPart) => part.type === 'file' && isImage(part));
  return {
    type: 'function_call_output',
    call_id: block.callId,
    output: hasImage ? result.content.flatMap(outputItem) : resultText(result),
  };
}

function inputItems(messages: readonly LlmMessage[]): ResponseInputItem[] {
  return messages.flatMap((message: LlmMessage): ResponseInputItem[] => {
    switch (message.role) {
      case 'system':
      case 'user': {
        return inputMessage(message.role, message);
      }
      case 'assistant': {
        return assistantItems(message);
      }
      default: {
        return resultsInCallOrder(message, messages).map((block: ToolResultBlock) =>
          toolOutput(block),
        );
      }
    }
  });
}

function functionTool(tool: ToolDeclaration): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // Tool schemas are arbitrary JSON Schema; strict mode accepts only a subset of it.
    strict: false,
  };
}

function effortOf(effort: string | undefined): NonNullable<ReasoningEffort> | undefined {
  return EFFORTS.find((known: string) => known === effort);
}

/**
 * Builds the Responses API request for `request`.
 *
 * Tool results are sent in the order the model made the calls. `request.effort` is sent
 * only when it is a level the API defines; `request.cacheKey` becomes `prompt_cache_key`.
 * `cacheBoundary` is not used: OpenAI caches prompt prefixes implicitly.
 */
export function buildResponsesRequest(
  model: string,
  request: LlmRequest,
): ResponseCreateParamsStreaming {
  const effort = effortOf(request.effort);
  return {
    model,
    input: inputItems(request.messages),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.tools.length === 0
      ? {}
      : { tools: request.tools.map(functionTool), parallel_tool_calls: true }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(request.cacheKey === undefined ? {} : { prompt_cache_key: request.cacheKey }),
  };
}
