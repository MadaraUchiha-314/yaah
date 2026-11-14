/**
 * The Anthropic `llm` entity: one Claude model called over the Messages API with the
 * official SDK, streaming.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';

import type { Locality } from '../../../../kernel/entity.ts';
import { t } from '../../../../kernel/strings.ts';
import type { LLM, LlmCapabilities, LlmEvent, LlmRequest } from '../types.ts';
import { ResponseAccumulator, abortedError, incompleteError, toLlmError } from './events.ts';
import { PROVIDER, buildParams } from './request.ts';

/** The `fetch` the SDK calls; tests pass one that replays recorded responses. */
export type AnthropicFetch = NonNullable<ClientOptions['fetch']>;

/** The API's address. Fixed, so an `ANTHROPIC_BASE_URL` in the environment cannot move it. */
export const ANTHROPIC_URL = 'https://api.anthropic.com';

const CLAUDE_5: LlmCapabilities = {
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  input: ['image'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const UNKNOWN: LlmCapabilities = {
  contextWindow: 200_000,
  maxOutput: 16_384,
  input: ['image'],
  efforts: [],
};

const KNOWN: ReadonlyMap<string, LlmCapabilities> = new Map([
  ['claude-opus-5-5', CLAUDE_5],
  ['claude-sonnet-5-5', CLAUDE_5],
  ['claude-haiku-5-5', CLAUDE_5],
  ['claude-fable-5-2', CLAUDE_5],
]);

/**
 * What `model` can take, from the built-in table. A model id the table does not list gets
 * conservative limits and no effort levels.
 */
export function anthropicCapabilities(model: string): LlmCapabilities {
  return KNOWN.get(model) ?? UNKNOWN;
}

/** What {@link createAnthropicLlm} needs. */
export interface AnthropicLlmOptions {
  /** The API's model id, such as `claude-opus-5-5`. Registered as `anthropic/<model>`. */
  readonly model: string;
  /** The API key. Sent only in the SDK's authentication header; never put in an error. */
  readonly apiKey: string;
  /** Replaces the global `fetch`. */
  readonly fetch?: AnthropicFetch | undefined;
  /** Overrides the built-in capabilities table. */
  readonly capabilities?: LlmCapabilities | undefined;
}

/**
 * Creates the `llm` entity `anthropic/<model>`.
 *
 * Invariants:
 * - One HTTP attempt per `stream` call: the SDK's own retries are off, because the caller
 *   decides about retrying from `LlmError.retryable`.
 * - `max_tokens` is the model's `capabilities.maxOutput`; `thinking` is left to the model's
 *   default; `tool_choice` is never forced.
 * - The SDK logs nothing, whatever `ANTHROPIC_LOG` says: its debug log would print headers.
 * - `stream` throws only `LlmError`, and never one that contains the API key. An aborted
 *   signal ends it with a non-retryable `LlmError`.
 */
export function createAnthropicLlm(options: AnthropicLlmOptions): LLM {
  const { model, apiKey } = options;
  const capabilities = options.capabilities ?? anthropicCapabilities(model);
  const locality: Locality = { type: 'remote', protocol: 'https', url: ANTHROPIC_URL };
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_URL,
    maxRetries: 0,
    // The SDK's debug log prints request headers; yaah reports failures itself.
    logLevel: 'off',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  async function* stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    const response = new ResponseAccumulator();
    try {
      const events = await client.messages.create(buildParams(request, model, capabilities), {
        signal,
      });
      for await (const event of events) {
        yield* response.push(event);
      }
    } catch (error) {
      throw toLlmError(error, model, apiKey);
    }
    if (!response.complete) {
      throw signal.aborted ? abortedError(model) : incompleteError(model);
    }
    yield response.done();
  }

  return {
    ref: { kind: 'llm', id: `${PROVIDER}/${model}`, version: null },
    description: t('llm.anthropic.description', { model }),
    locality,
    capabilities,
    stream,
  };
}
