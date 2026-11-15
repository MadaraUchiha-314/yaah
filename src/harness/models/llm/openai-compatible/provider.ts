/**
 * The provider for any OpenAI-compatible endpoint (OpenRouter, Ollama, a gateway): one
 * `llm` entity per model, on the Chat Completions API of the official SDK pointed at the
 * endpoint's base URL. Streaming, tool calls and image input.
 */
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

import { t } from '../../../../kernel/strings.ts';
import type { TokenUsage } from '../../../core/types.ts';
import type { LLM, LlmCapabilities, LlmEvent, LlmRequest, StopReason } from '../types.ts';
import { NO_USAGE } from '../types.ts';
import type { FetchLike } from '../openai/content.ts';
import { parseArguments } from '../openai/content.ts';
import type { ErrorScope } from '../openai/errors.ts';
import { abortedError, argumentsError, toLlmError, truncatedError } from '../openai/errors.ts';
import { buildChatRequest } from './request.ts';

/** What {@link createCompatibleLlm} needs. */
export interface CompatibleLlmOptions {
  /** The endpoint's id in the configuration; the entity is `<providerId>/<model>`. */
  readonly providerId: string;
  /** The model id as the endpoint names it. */
  readonly model: string;
  /** The endpoint's base URL, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  /** The API key, when the endpoint wants one. Without it no credential is sent. */
  readonly apiKey?: string | undefined;
  readonly capabilities: LlmCapabilities;
  /** Replaces the global `fetch`; tests use it to replay recorded responses. */
  readonly fetch?: FetchLike | undefined;
}

/** A tool call being assembled from streamed deltas. */
interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** What one response has produced so far. */
interface Progress {
  /** Tool calls by the index the endpoint streams them under. */
  readonly calls: Map<number, PendingCall>;
  finish: string | null;
  refused: boolean;
  usage: TokenUsage;
}

type Delta = ChatCompletionChunk.Choice.Delta;

function usageOf(usage: NonNullable<ChatCompletionChunk['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function accumulate(progress: Progress, deltas: NonNullable<Delta['tool_calls']>): void {
  for (const delta of deltas) {
    const pending = progress.calls.get(delta.index) ?? { id: '', name: '', args: '' };
    pending.id = delta.id ?? pending.id;
    pending.name = delta.function?.name ?? pending.name;
    pending.args += delta.function?.arguments ?? '';
    progress.calls.set(delta.index, pending);
  }
}

/** Folds one chunk into `progress` and returns the text it carries. */
function textOf(chunk: ChatCompletionChunk, progress: Progress): string {
  if (chunk.usage !== undefined && chunk.usage !== null) {
    progress.usage = usageOf(chunk.usage);
  }
  const [choice] = chunk.choices;
  if (choice === undefined) {
    return '';
  }
  progress.finish = choice.finish_reason ?? progress.finish;
  if (choice.delta.tool_calls !== undefined) {
    accumulate(progress, choice.delta.tool_calls);
  }
  const refusal = choice.delta.refusal ?? '';
  progress.refused ||= refusal !== '';
  return `${choice.delta.content ?? ''}${refusal}`;
}

function stopReason(progress: Progress): StopReason {
  if (progress.refused || progress.finish === 'content_filter') {
    return 'refusal';
  }
  if (progress.finish === 'length') {
    return 'length';
  }
  return progress.calls.size > 0 ? 'tool-calls' : 'end';
}

/**
 * The events that close a response: its tool calls in index order, then `done`.
 *
 * @throws LlmError when a call's arguments are not JSON.
 */
function closingEvents(scope: ErrorScope, progress: Progress): LlmEvent[] {
  const ordered = [...progress.calls.entries()].toSorted(
    (a: [number, PendingCall], b: [number, PendingCall]) => a[0] - b[0],
  );
  // Some endpoints omit the id. The index is unique only within this response, and a
  // conversation pairs each result with its call by id, so the response gets a suffix.
  const response = globalThis.crypto.randomUUID().slice(0, 8);
  const events = ordered.map(([index, pending]: [number, PendingCall]): LlmEvent => {
    const args = parseArguments(pending.args);
    if (args === undefined) {
      throw argumentsError(scope, pending.name);
    }
    const id = pending.id === '' ? `call_${response}_${index}` : pending.id;
    return { type: 'tool-call', call: { id, name: pending.name, args } };
  });
  return [...events, { type: 'done', usage: progress.usage, stopReason: stopReason(progress) }];
}

async function* streamCompletion(
  client: OpenAI,
  scope: ErrorScope,
  request: LlmRequest,
  signal: AbortSignal,
): AsyncGenerator<LlmEvent> {
  if (signal.aborted) {
    throw abortedError(scope);
  }
  const progress: Progress = { calls: new Map(), finish: null, refused: false, usage: NO_USAGE };
  try {
    const params = buildChatRequest(scope.model, request);
    const stream = await client.chat.completions.create(params, { signal });
    for await (const chunk of stream) {
      const text = textOf(chunk, progress);
      if (text !== '') {
        yield { type: 'text.delta', text };
      }
    }
    if (progress.finish === null) {
      throw truncatedError(scope);
    }
    yield* closingEvents(scope, progress);
  } catch (error) {
    throw toLlmError(scope, error, signal);
  }
}

/**
 * Creates the `llm` entity `<providerId>/<model>` for an OpenAI-compatible endpoint.
 *
 * The entity never retries: a failed call is one {@link LlmError}. Tool calls are emitted
 * once the response is complete, because the dialect streams their arguments in pieces.
 * Without `apiKey` no `Authorization` header is sent — the ambient `OPENAI_API_KEY` is
 * never forwarded to a third-party endpoint.
 */
export function createCompatibleLlm(options: CompatibleLlmOptions): LLM {
  const keyed = options.apiKey !== undefined && options.apiKey !== '';
  const client = new OpenAI({
    // The SDK insists on a key; without one the header that would carry it is removed.
    apiKey: keyed ? options.apiKey : 'unused',
    baseURL: options.baseUrl,
    maxRetries: 0,
    // In a browser the SDK refuses to start without this. Whoever starts a harness in a tab
    // has already decided whose key or proxy it calls; on Node the flag does nothing.
    dangerouslyAllowBrowser: true,
    organization: null,
    project: null,
    fetch: options.fetch,
    ...(keyed ? {} : { defaultHeaders: { Authorization: null } }),
  });
  const scope: ErrorScope = {
    provider: options.providerId,
    model: options.model,
    secrets: keyed && options.apiKey !== undefined ? [options.apiKey] : [],
  };
  return {
    ref: { kind: 'llm', id: `${options.providerId}/${options.model}`, version: null },
    description: t('llm.compatible.description', {
      provider: options.providerId,
      model: options.model,
    }),
    locality: { type: 'remote', protocol: 'https', url: options.baseUrl },
    capabilities: options.capabilities,
    stream: (request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> =>
      streamCompletion(client, scope, request, signal),
  };
}
