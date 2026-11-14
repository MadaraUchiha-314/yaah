/**
 * Agents as entities. An agent — this harness itself, a local copy with a fresh context,
 * or a remote one that may not be yaah at all — is reached through one interface, which
 * is the A2A protocol in TypeScript clothes.
 */
import type { AgentCard, Message, StreamResponse, Task } from '@a2a-js/sdk';

import type { Entity } from '../../kernel/entity.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    agent: Agent;
  }
}

/** Options of one call to an agent. */
export interface AgentCallOptions {
  /** URIs of the A2A extensions to activate for this call. */
  readonly extensions?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** One thing an agent says it can do, from its card. */
export interface AgentSkillSummary {
  readonly name: string;
  readonly description: string;
}

/**
 * An agent that can be sent work.
 *
 * The three operations mirror the agent interface of the A2A SDKs: send a message and
 * stream what comes back, cancel a task, read the card.
 */
export interface Agent extends Entity<'agent'> {
  /** The agent's own name, from its card. Third-party text. */
  readonly name: string;
  /** What the agent says it can do, from its card. Third-party text. */
  readonly skills: readonly AgentSkillSummary[];
  /** Sends a message and yields the A2A events of the response, in order. */
  sendMessage(request: Message, options?: AgentCallOptions): AsyncIterable<StreamResponse>;
  /** Cancels a task on the agent. */
  cancelTask(taskId: string, options?: AgentCallOptions): Promise<Task>;
  /** The agent's card. */
  getCard(): Promise<AgentCard>;
}
