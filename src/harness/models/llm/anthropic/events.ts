/**
 * Turns the Messages API's raw stream events into {@link LlmEvent}s, and SDK failures
 * into {@link LlmError}s.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';

import type { Json } from '../../../../kernel/json.ts';
import { REDACTED } from '../../../../kernel/redactor.ts';
import { t } from '../../../../kernel/strings.ts';
import type { TokenUsage } from '../../../core/types.ts';
import type { LlmEvent, StopReason } from '../types.ts';
import { LlmError } from '../types.ts';
import { PROVIDER } from './request.ts';

type RawEvent = Anthropic.RawMessageStreamEvent;

/** A block still being received: a tool call's JSON so far, or a thinking block so far. */
type Pending =
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; json: string }
  | { readonly kind: 'thinking'; readonly block: Anthropic.ThinkingBlock };

/** Error types that are worth retrying when no HTTP status came with them (mid-stream). */
const RETRYABLE_TYPES: ReadonlySet<string> = new Set([
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
]);

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 429]);
const SERVER_ERROR = 500;

function toJson(value: unknown): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => toJson(item));
  }
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    result[key] = toJson(item);
  }
  return result;
}

/** The arguments of a tool call, or undefined when the model's JSON is not complete. */
function parseArgs(json: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(json === '' ? '{}' : json);
    return toJson(parsed);
  } catch {
    return undefined;
  }
}

function mapStop(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'tool_use': {
      return 'tool-calls';
    }
    case 'max_tokens':
    case 'model_context_window_exceeded': {
      return 'length';
    }
    case 'refusal': {
      return 'refusal';
    }
    default: {
      return 'end';
    }
  }
}

/**
 * Accumulates one response.
 *
 * Invariants: events come out in the order of the response's content blocks. A tool call
 * is emitted once, when its block is complete, with parsed arguments; a tool call whose
 * JSON is not valid (a response cut at the output limit) is not emitted. A thinking or
 * redacted-thinking block is emitted whole, as the API would return it.
 */
export class ResponseAccumulator {
  readonly #pending = new Map<number, Pending>();
  #input = 0;
  #output = 0;
  #cacheRead = 0;
  #cacheWrite = 0;
  #stop: Anthropic.StopReason | null = null;
  #complete = false;

  /** Whether `message_stop` was received. */
  get complete(): boolean {
    return this.#complete;
  }

  /** The events one raw stream event gives rise to; often none. */
  push(event: RawEvent): readonly LlmEvent[] {
    switch (event.type) {
      case 'message_start': {
        this.#usage(event.message.usage);
        return [];
      }
      case 'content_block_start': {
        return this.#start(event);
      }
      case 'content_block_delta': {
        return this.#delta(event);
      }
      case 'content_block_stop': {
        return this.#finish(event.index);
      }
      case 'message_delta': {
        this.#usage(event.usage);
        this.#stop = event.delta.stop_reason;
        return [];
      }
      default: {
        this.#complete = true;
        return [];
      }
    }
  }

  /**
   * The closing event. `inputTokens` is the whole prompt — uncached, cache-written and
   * cache-read tokens together — and `cachedInputTokens` the cache-read part of it.
   */
  done(): LlmEvent {
    const usage: TokenUsage = {
      inputTokens: this.#input + this.#cacheWrite + this.#cacheRead,
      outputTokens: this.#output,
      cachedInputTokens: this.#cacheRead,
    };
    return { type: 'done', usage, stopReason: mapStop(this.#stop) };
  }

  #usage(usage: Anthropic.Usage | Anthropic.MessageDeltaUsage): void {
    this.#input = usage.input_tokens ?? this.#input;
    this.#output = usage.output_tokens;
    this.#cacheRead = usage.cache_read_input_tokens ?? this.#cacheRead;
    this.#cacheWrite = usage.cache_creation_input_tokens ?? this.#cacheWrite;
  }

  #start(event: Anthropic.RawContentBlockStartEvent): readonly LlmEvent[] {
    const block = event.content_block;
    if (block.type === 'tool_use') {
      this.#pending.set(event.index, { kind: 'tool', id: block.id, name: block.name, json: '' });
    } else if (block.type === 'thinking') {
      this.#pending.set(event.index, { kind: 'thinking', block: { ...block } });
    } else if (block.type === 'redacted_thinking') {
      return [{ type: 'reasoning', opaque: { provider: PROVIDER, data: { ...block } } }];
    }
    return [];
  }

  #delta(event: Anthropic.RawContentBlockDeltaEvent): readonly LlmEvent[] {
    const { delta } = event;
    const pending = this.#pending.get(event.index);
    if (delta.type === 'text_delta') {
      return [{ type: 'text.delta', text: delta.text }];
    }
    if (delta.type === 'input_json_delta' && pending?.kind === 'tool') {
      pending.json += delta.partial_json;
    } else if (delta.type === 'thinking_delta' && pending?.kind === 'thinking') {
      pending.block.thinking += delta.thinking;
    } else if (delta.type === 'signature_delta' && pending?.kind === 'thinking') {
      pending.block.signature = delta.signature;
    }
    return [];
  }

  #finish(index: number): readonly LlmEvent[] {
    const pending = this.#pending.get(index);
    this.#pending.delete(index);
    if (pending?.kind === 'thinking') {
      return [{ type: 'reasoning', opaque: { provider: PROVIDER, data: { ...pending.block } } }];
    }
    if (pending?.kind === 'tool') {
      const args = parseArgs(pending.json);
      if (args !== undefined) {
        return [{ type: 'tool-call', call: { id: pending.id, name: pending.name, args } }];
      }
    }
    return [];
  }
}

/** The request was aborted through its signal. Not retryable. */
export function abortedError(model: string): LlmError {
  return new LlmError(
    PROVIDER,
    model,
    false,
    t('llm.error.aborted', { provider: PROVIDER, model }),
  );
}

/** The stream ended before `message_stop`. Retryable. */
export function incompleteError(model: string): LlmError {
  return new LlmError(
    PROVIDER,
    model,
    true,
    t('llm.error.incomplete', { provider: PROVIDER, model }),
  );
}

function describe(error: unknown, model: string): { retryable: boolean; message: string } {
  const params = { provider: PROVIDER, model };
  if (error instanceof APIConnectionError) {
    return { retryable: true, message: t('llm.error.connection', params) };
  }
  if (error instanceof APIError) {
    const status: unknown = error.status;
    const type = error.type ?? '';
    const detail = { ...params, type, reason: error.apiMessage ?? '' };
    if (typeof status !== 'number') {
      return { retryable: RETRYABLE_TYPES.has(type), message: t('llm.error.stream', detail) };
    }
    return {
      retryable: RETRYABLE_STATUS.has(status) || status >= SERVER_ERROR,
      message: t('llm.error.status', { ...detail, status }),
    };
  }
  // Anything else broke in transport or while reading the stream.
  return { retryable: true, message: t('llm.error.connection', params) };
}

/**
 * Maps whatever a call threw to an {@link LlmError}.
 *
 * Retryable: HTTP 408, 409, 429 and every 5xx (529 included), connection failures and
 * timeouts, and mid-stream `overloaded_error`, `api_error`, `rate_limit_error` and
 * `timeout_error`. Not retryable: every other status (400, 401, 403, 404, 413, 422, …)
 * and an abort.
 *
 * Invariant: neither the message nor the cause of the returned error contains `apiKey`.
 */
export function toLlmError(error: unknown, model: string, apiKey: string): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  if (error instanceof APIUserAbortError) {
    return abortedError(model);
  }
  const { retryable, message } = describe(error, model);
  if (apiKey === '') {
    return new LlmError(PROVIDER, model, retryable, message, error);
  }
  const leaks = error instanceof Error && error.message.includes(apiKey);
  return new LlmError(
    PROVIDER,
    model,
    retryable,
    message.replaceAll(apiKey, REDACTED),
    leaks ? undefined : error,
  );
}
