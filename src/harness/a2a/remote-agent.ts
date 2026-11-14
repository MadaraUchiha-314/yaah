/** An agent reached over A2A with the official SDK client. */
import type { AgentCard, Message, StreamResponse, Task } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';

import { ConfigError } from '../../kernel/errors.ts';
import { t } from '../../kernel/strings.ts';
import type { Agent, AgentCallOptions } from './types.ts';

/** What a remote agent is built from. */
export interface RemoteAgentInit {
  /** The entity id the model uses to name the agent. */
  readonly id: string;
  /** Where the card is, or the agent's base URL. */
  readonly url: string;
  /** Hosts the card's interfaces may point to besides the card's own host. */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Used instead of the card's name and description, when given. */
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

function callOptions(options: AgentCallOptions = {}): {
  signal?: AbortSignal;
  serviceParameters?: ServiceParameters;
} {
  const extensions = options.extensions ?? [];
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(extensions.length === 0
      ? {}
      : { serviceParameters: ServiceParameters.create(withA2AExtensions(...extensions)) }),
  };
}

/** Splits a card URL into the base and the card path the SDK's factory wants. */
function locate(url: string): { base: string; path: string | undefined } {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//u, '');
  return { base: parsed.origin, path: path === '' ? undefined : path };
}

/**
 * Refuses a card that sends calls somewhere its publisher was not vouched for. The
 * operator named the card's host; a card may only point its interfaces at that host or
 * at one the operator explicitly allowed.
 *
 * @throws ConfigError `agent.interface-host` otherwise.
 */
export function assertInterfaceHosts(init: RemoteAgentInit, card: AgentCard): void {
  const own = new URL(init.url).host;
  const allowed = new Set([own, ...(init.allowedHosts ?? [])]);
  for (const entry of card.supportedInterfaces) {
    const { host } = new URL(entry.url);
    if (!allowed.has(host)) {
      const message = t('error.agent.interface-host', { id: init.id, host });
      throw new ConfigError('agent.interface-host', message, 'config.toml', 'a2a.allowed_hosts');
    }
  }
}

/**
 * Connects to a remote agent: fetches its card, checks where the card points, and wraps
 * the SDK client as an `agent` entity.
 *
 * @throws ConfigError when the card names a host that is not allowed.
 * @throws when the card cannot be fetched.
 */
export async function connectRemoteAgent(init: RemoteAgentInit): Promise<Agent> {
  const { base, path } = locate(init.url);
  const client: Client = await new ClientFactory().createFromUrl(base, path);
  const card = await client.getAgentCard();
  assertInterfaceHosts(init, card);
  return {
    ref: { kind: 'agent', id: init.id, version: null },
    name: init.name ?? card.name,
    description: init.description ?? card.description,
    locality: { type: 'remote', protocol: 'a2a', url: init.url },
    skills: card.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    sendMessage: (request: Message, options?: AgentCallOptions): AsyncIterable<StreamResponse> =>
      client.sendMessageStream(
        { tenant: '', message: request, configuration: undefined, metadata: undefined },
        callOptions(options),
      ),
    cancelTask: (taskId: string, options?: AgentCallOptions): Promise<Task> =>
      client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, callOptions(options)),
    getCard: (): Promise<AgentCard> => Promise.resolve(card),
  };
}
