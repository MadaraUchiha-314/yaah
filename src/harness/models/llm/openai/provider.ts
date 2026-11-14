/**
 * The native OpenAI provider: one `llm` entity per model, on the Responses API of the
 * official SDK. Streaming, parallel tool calls, encrypted reasoning passed back unchanged,
 * image input, reasoning effort and prompt-cache partitioning.
 */
import OpenAI from 'openai';
import type {
  Response as ApiResponse,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import { t } from '../../../../kernel/strings.ts';
import type { TokenUsage } from '../../../core/types.ts';
import type { LLM, LlmCapabilities, LlmEvent, LlmRequest, StopReason } from '../types.ts';
import type { FetchLike } from './content.ts';
import { parseArguments, toJson } from './content.ts';
import type { ErrorScope } from './errors.ts';
import {
  abortedError,
  argumentsError,
  streamFailure,
  toLlmError,
  truncatedError,
} from './errors.ts';
import { OPENAI, buildResponsesRequest } from './request.ts';

/** Where OpenAI's API lives unless a base URL says otherwise. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const FLAGSHIP: LlmCapabilities = {
  contextWindow: 1_050_000,
  maxOutput: 128_000,
  input: ['image'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const UNKNOWN_MODEL: LlmCapabilities = {
  contextWindow: 128_000,
  maxOutput: 16_384,
  input: [],
  efforts: [],
};
const KNOWN_MODELS: ReadonlySet<string> = new Set(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra']);

/**
 * What yaah assumes about an OpenAI model. A model id it does not know gets conservative
 * limits, text-only input and no reasoning effort.
 */
export function openAiCapabilities(model: string): LlmCapabilities {
  return KNOWN_MODELS.has(model) ? FLAGSHIP : UNKNOWN_MODEL;
}

/** What {@link createOpenAiLlm} needs. */
export interface OpenAiLlmOptions {
  /** The model id as OpenAI names it, e.g. `gpt-6.1-sol`. */
  readonly model: string;
  /** The API key. Sent only as the bearer token; never logged or put in an error. */
  readonly apiKey: string;
  /** Defaults to {@link OPENAI_BASE_URL}. */
  readonly baseUrl?: string | undefined;
  /** Replaces the global `fetch`; tests use it to replay recorded responses. */
  readonly fetch?: FetchLike | undefined;
  /** Defaults to {@link openAiCapabilities} of the model. */
  readonly capabilities?: LlmCapabilities | undefined;
}

/** What one response has produced so far. */
interface Progress {
  toolCalls: number;
  refused: boolean;
}

function usageOf(response: ApiResponse): TokenUsage {
  const usage: Partial<NonNullable<ApiResponse['usage']>> = response.usage ?? {};
  const details: Partial<NonNullable<ApiResponse['usage']>['input_tokens_details']> =
    usage.input_tokens_details ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: details.cached_tokens ?? 0,
  };
}

function done(response: ApiResponse, stopReason: StopReason): LlmEvent {
  return { type: 'done', usage: usageOf(response), stopReason };
}

function itemEvents(scope: ErrorScope, item: ResponseOutputItem, progress: Progress): LlmEvent[] {
  if (item.type === 'reasoning') {
    return [{ type: 'reasoning', opaque: { provider: OPENAI, data: toJson(item) } }];
  }
  if (item.type !== 'function_call') {
    return [];
  }
  const args = parseArguments(item.arguments);
  if (args === undefined) {
    throw argumentsError(scope, item.name);
  }
  progress.toolCalls += 1;
  return [{ type: 'tool-call', call: { id: item.call_id, name: item.name, args } }];
}

function incompleteReason(response: ApiResponse): StopReason {
  return response.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'length';
}

function completedReason(progress: Progress): StopReason {
  if (progress.refused) {
    return 'refusal';
  }
  return progress.toolCalls > 0 ? 'tool-calls' : 'end';
}

/**
 * The events one stream event becomes. The last event of a response is a `done`.
 *
 * @throws LlmError when the event reports a failure or carries unparseable tool arguments.
 */
function eventsOf(scope: ErrorScope, event: ResponseStreamEvent, progress: Progress): LlmEvent[] {
  switch (event.type) {
    case 'response.output_text.delta': {
      return [{ type: 'text.delta', text: event.delta }];
    }
    case 'response.refusal.delta': {
      progress.refused = true;
      return [{ type: 'text.delta', text: event.delta }];
    }
    case 'response.output_item.done': {
      return itemEvents(scope, event.item, progress);
    }
    case 'response.completed': {
      return [done(event.response, completedReason(progress))];
    }
    case 'response.incomplete': {
      return [done(event.response, incompleteReason(event.response))];
    }
    case 'response.failed': {
      throw streamFailure(scope, event.response.error?.code);
    }
    case 'error': {
      throw streamFailure(scope, event.code);
    }
    default: {
      return [];
    }
  }
}

async function* streamResponse(
  client: OpenAI,
  scope: ErrorScope,
  request: LlmRequest,
  signal: AbortSignal,
): AsyncGenerator<LlmEvent> {
  if (signal.aborted) {
    throw abortedError(scope);
  }
  const progress: Progress = { toolCalls: 0, refused: false };
  try {
    const params = buildResponsesRequest(scope.model, request);
    const stream = await client.responses.create(params, { signal });
    for await (const event of stream) {
      const events = eventsOf(scope, event, progress);
      yield* events;
      if (events.at(-1)?.type === 'done') {
        return;
      }
    }
    throw truncatedError(scope);
  } catch (error) {
    throw toLlmError(scope, error, signal);
  }
}

/**
 * Creates the `llm` entity `openai/<model>`.
 *
 * The entity never retries: a failed call is one {@link LlmError}, and its `retryable`
 * flag tells the caller whether to try again. Requests are stateless (`store: false`).
 */
export function createOpenAiLlm(options: OpenAiLlmOptions): LLM {
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    // Ambient OPENAI_ORG_ID / OPENAI_PROJECT_ID must not change what a configured model does.
    organization: null,
    project: null,
    fetch: options.fetch,
  });
  const scope: ErrorScope = { provider: OPENAI, model: options.model, secrets: [options.apiKey] };
  return {
    ref: { kind: 'llm', id: `${OPENAI}/${options.model}`, version: null },
    description: t('llm.openai.description', { model: options.model }),
    locality: { type: 'remote', protocol: 'https', url: baseUrl },
    capabilities: options.capabilities ?? openAiCapabilities(options.model),
    stream: (request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> =>
      streamResponse(client, scope, request, signal),
  };
}
