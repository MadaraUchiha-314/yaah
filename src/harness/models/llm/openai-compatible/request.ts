/**
 * Renders an {@link LlmRequest} as a Chat Completions request — the dialect every
 * OpenAI-compatible endpoint speaks.
 *
 * Only what the dialect reliably carries is sent: text, images, tool calls and tool
 * results. Reasoning blocks, non-image files, `effort` and `cacheKey` have no portable
 * representation and are left out.
 */
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import type { ContentPart } from '../../../core/types.ts';
import type { LlmContent, LlmMessage, LlmRequest, ToolDeclaration } from '../types.ts';
import type { ToolResultBlock } from '../openai/content.ts';
import {
  fileUrl,
  isImage,
  messageText,
  partText,
  resultText,
  resultsInCallOrder,
} from '../openai/content.ts';

function isContentPart(block: LlmContent): block is ContentPart {
  return block.type === 'text' || block.type === 'file' || block.type === 'data';
}

function userPart(part: ContentPart): ChatCompletionContentPart[] {
  if (part.type !== 'file') {
    return [{ type: 'text', text: partText(part) ?? '' }];
  }
  return isImage(part) ? [{ type: 'image_url', image_url: { url: fileUrl(part) } }] : [];
}

/** A user message: plain text when it is only text, content parts otherwise. */
function userMessage(message: LlmMessage): ChatCompletionMessageParam {
  const parts = message.content.filter(isContentPart);
  const textOnly = parts.every((part: ContentPart) => part.type === 'text');
  return {
    role: 'user',
    content: textOnly ? messageText(parts) : parts.flatMap((part: ContentPart) => userPart(part)),
  };
}

function assistantMessage(message: LlmMessage): ChatCompletionAssistantMessageParam {
  const text = messageText(message.content);
  const calls = message.content.flatMap((block: LlmContent): ChatCompletionMessageToolCall[] =>
    block.type === 'tool-call'
      ? [
          {
            id: block.call.id,
            type: 'function',
            function: { name: block.call.name, arguments: JSON.stringify(block.call.args) },
          },
        ]
      : [],
  );
  return {
    role: 'assistant',
    content: text === '' ? null : text,
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
  };
}

function toolMessage(block: ToolResultBlock): ChatCompletionMessageParam {
  return { role: 'tool', tool_call_id: block.callId, content: resultText(block.result) };
}

function chatMessages(messages: readonly LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.flatMap((message: LlmMessage): ChatCompletionMessageParam[] => {
    switch (message.role) {
      case 'system': {
        return [{ role: 'system', content: messageText(message.content) }];
      }
      case 'user': {
        return [userMessage(message)];
      }
      case 'assistant': {
        return [assistantMessage(message)];
      }
      default: {
        return resultsInCallOrder(message, messages).map((block: ToolResultBlock) =>
          toolMessage(block),
        );
      }
    }
  });
}

function chatTool(tool: ToolDeclaration): ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

/**
 * Builds the Chat Completions request for `request`.
 *
 * Tool results follow the assistant message that made the calls, one `tool` message per
 * result, in call order. The stream is asked to report usage in its last chunk.
 */
export function buildChatRequest(
  model: string,
  request: LlmRequest,
): ChatCompletionCreateParamsStreaming {
  return {
    model,
    messages: chatMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(chatTool) }),
  };
}
