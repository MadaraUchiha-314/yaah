/**
 * The provider-agnostic LLM interface. Every provider — OpenAI, Anthropic, any
 * OpenAI-compatible endpoint — is an `llm` entity implementing {@link LLM}; nothing above
 * this file knows which one it is talking to.
 */
import type { Entity } from '../../../kernel/entity.ts';
import { YaahError } from '../../../kernel/errors.ts';
import type { JsonObject } from '../../../kernel/json.ts';
import type {
  ContentPart,
  ProviderOpaque,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../../core/types.ts';

declare module '../../../kernel/entity.ts' {
  interface EntityMap {
    llm: LLM;
  }
}

/** What a model can take and how much. */
export interface LlmCapabilities {
  /** Total tokens the model accepts in one request. */
  readonly contextWindow: number;
  /** Most tokens the model produces in one response. */
  readonly maxOutput: number;
  /** Input modalities beyond text. */
  readonly input: readonly ('image' | 'audio')[];
  /** Reasoning-effort levels the model accepts; empty when it has none. */
  readonly efforts: readonly string[];
}

/** A tool as the model sees it. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly inputSchema: JsonObject;
}

/** One block of a message sent to a model. */
export type LlmContent =
  | ContentPart
  | {
      readonly type: 'tool-call';
      readonly call: ToolCall;
      readonly opaque?: ProviderOpaque | undefined;
    }
  | { readonly type: 'tool-result'; readonly callId: string; readonly result: ToolResult }
  | { readonly type: 'reasoning'; readonly opaque: ProviderOpaque };

/** One message of a request. */
export interface LlmMessage {
  /** `tool` carries only tool-result blocks. */
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: readonly LlmContent[];
  /**
   * Everything up to and including this message is stable across calls: a provider that
   * supports explicit prompt caching places a cache breakpoint here.
   */
  readonly cacheBoundary?: boolean | undefined;
}

/** One call to a model. */
export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDeclaration[];
  /** One of the model's `capabilities.efforts`. */
  readonly effort?: string | undefined;
  /** Partitions the provider's prompt cache; the task id is a good value. */
  readonly cacheKey?: string | undefined;
}

/** Why a model stopped. */
export type StopReason = 'end' | 'tool-calls' | 'length' | 'refusal';

/**
 * What a model emits while answering.
 *
 * Invariants: `done` is emitted exactly once and is the last event. Every `tool-call`
 * carries complete, parsed arguments and an id unique within the response.
 */
export type LlmEvent =
  | { readonly type: 'text.delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly call: ToolCall;
      readonly opaque?: ProviderOpaque | undefined;
    }
  | { readonly type: 'reasoning'; readonly opaque: ProviderOpaque }
  | { readonly type: 'done'; readonly usage: TokenUsage; readonly stopReason: StopReason };

/** A model that can be called. */
export interface LLM extends Entity<'llm'> {
  readonly capabilities: LlmCapabilities;
  /**
   * Streams the model's answer to `request`.
   *
   * Aborting `signal` ends the stream promptly; the iterator then throws or returns.
   *
   * @throws LlmError when the provider fails. `retryable` says whether trying again can help.
   */
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
}

/** A provider call failed. */
export class LlmError extends YaahError {
  readonly provider: string;
  readonly model: string;
  /** True for rate limits, timeouts and server errors; false for bad requests and auth. */
  readonly retryable: boolean;

  constructor(
    provider: string,
    model: string,
    retryable: boolean,
    message: string,
    cause?: unknown,
  ) {
    super(retryable ? 'llm.retryable' : 'llm.fatal', message, cause);
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
  }
}

/** A usage record of zero tokens. */
export const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
