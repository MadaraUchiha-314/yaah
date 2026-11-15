/**
 * The OpenAI-compatible plugin: for every endpoint under `providers.compatible`, registers
 * one `llm` entity, `<endpoint id>/<model>`, per model id the endpoint lists.
 *
 * An endpoint's key is optional. When the configuration names an environment variable for
 * it, the key is read once, at start, and handed to the redactor; if the variable is not
 * set the endpoint fails closed — none of its models is registered, and the plugin
 * refuses to start when the default model is one of them.
 */
import type { Context } from 'cordis';

import type { CompatibleProviderConfig } from '../../../../kernel/config-types.ts';
import { readCredential } from '../../../../kernel/credentials.ts';
import { registerEntity } from '../../../../kernel/registry.ts';
import type { FetchLike } from '../openai/content.ts';
import { credentialError } from '../openai/index.ts';
import type { LlmCapabilities } from '../types.ts';
import { createCompatibleLlm } from './provider.ts';

export { createCompatibleLlm } from './provider.ts';
export type { CompatibleLlmOptions } from './provider.ts';

/** Configuration of the OpenAI-compatible plugin. Both fields exist for tests and embedders. */
export interface CompatiblePluginConfig {
  /** Keys by endpoint id, used instead of the endpoint's environment variable. */
  readonly apiKeys?: Readonly<Record<string, string>> | undefined;
  /** Replaces the global `fetch` for every endpoint. */
  readonly fetch?: FetchLike | undefined;
}

export const name = 'llm-openai-compatible';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

/** An endpoint whose credential has been resolved. `apiKey` is undefined for a keyless one. */
interface ReadyEndpoint {
  readonly endpoint: CompatibleProviderConfig;
  readonly apiKey: string | undefined;
}

/**
 * Resolves one endpoint's credential. Returns null for an endpoint that names a variable
 * which is not set and does not serve the default model.
 *
 * @throws ConfigError when that endpoint serves the default model.
 */
function resolve(
  ctx: Context,
  config: CompatiblePluginConfig | undefined,
  endpoint: CompatibleProviderConfig,
  index: number,
): ReadyEndpoint | null {
  const injected = config?.apiKeys?.[endpoint.id];
  if (injected !== undefined || endpoint.apiKeyEnv === undefined) {
    return { endpoint, apiKey: injected };
  }
  const apiKey = readCredential(ctx, endpoint.apiKeyEnv) ?? '';
  if (apiKey !== '') {
    return { endpoint, apiKey };
  }
  if (ctx.config.model.llm.startsWith(`${endpoint.id}/`)) {
    throw credentialError(endpoint.apiKeyEnv, `providers.compatible[${index}].api_key_env`);
  }
  return null;
}

/**
 * Starts the OpenAI-compatible endpoints. Every credential is resolved before anything is
 * registered, so a failure leaves no entity behind.
 *
 * Capabilities come from the endpoint's `context_window` and `max_output`; input is
 * assumed to be text only and no reasoning effort is offered, because the configuration
 * cannot say otherwise.
 *
 * @throws ConfigError (`config.credential`) when the endpoint serving `model.llm` names
 *   an environment variable that is not set.
 */
export function apply(ctx: Context, config: CompatiblePluginConfig | undefined): void {
  const ready = ctx.config.providers.compatible.flatMap(
    (endpoint: CompatibleProviderConfig, index: number) =>
      resolve(ctx, config, endpoint, index) ?? [],
  );
  for (const { endpoint, apiKey } of ready) {
    if (apiKey !== undefined) {
      ctx.redactor.add(apiKey);
    }
    const capabilities: LlmCapabilities = {
      contextWindow: endpoint.contextWindow,
      maxOutput: endpoint.maxOutput,
      input: [],
      efforts: [],
    };
    for (const model of endpoint.models) {
      registerEntity(
        ctx,
        createCompatibleLlm({
          providerId: endpoint.id,
          model,
          baseUrl: endpoint.baseUrl,
          apiKey,
          capabilities,
          fetch: config?.fetch,
        }),
      );
    }
  }
}
