/**
 * The sub-agents plugin: registers the agents the operator declared, the `self` agent,
 * and the `invoke_agent` tool.
 */
import type { AgentCard, Message, StreamResponse, Task } from '@a2a-js/sdk';
import type { Context } from 'cordis';

import { ConfigError } from '../../kernel/errors.ts';
import { LOCAL } from '../../kernel/entity.ts';
import { registerEntity } from '../../kernel/registry.ts';
import { createInvokeAgentTool } from './invoke-tool.ts';
import { agentOverClient, connectRemoteAgent } from './remote-agent.ts';
import type { Agent, AgentCallOptions } from './types.ts';

export { INVOKE_AGENT } from './invoke-tool.ts';
export { connectRemoteAgent } from './remote-agent.ts';
export type { Agent, AgentCallOptions, AgentSkillSummary } from './types.ts';

declare module 'cordis' {
  interface Events {
    /** A declared agent could not be reached; it will be tried again. */
    'agents/unavailable'(id: string, error: unknown): void;
    /** A declared agent was connected and registered. */
    'agents/registered'(id: string): void;
  }
}

/** Options of the sub-agents plugin. */
export interface SubAgentsConfig {
  /** Milliseconds between attempts to reach an agent that was unreachable. */
  readonly retryMs?: number;
}

export const name = 'a2a-agents';
export const inject: readonly string[] = [
  'entities',
  'config',
  'strings',
  'persistence',
  'taskRuntime',
  'harnessTarget',
];

const DEFAULT_RETRY_MS = 30_000;

/**
 * The harness itself as an agent: a copy with a fresh context, reached by an A2A call to
 * its own address — or, in a build with no listener, through the in-memory transport onto
 * its own request handler. The connection is made on first use.
 */
function selfAgent(ctx: Context): Agent {
  const target = ctx.harnessTarget;
  const open = async (): Promise<Agent> => {
    if (target.type === 'http') {
      return connectRemoteAgent({ id: 'self', url: target.url });
    }
    const client = await target.connect();
    return agentOverClient({ id: 'self' }, client, await client.getAgentCard(), LOCAL);
  };
  let connected: Promise<Agent> | null = null;
  const connect = (): Promise<Agent> => {
    connected ??= open();
    return connected;
  };
  return {
    ref: { kind: 'agent', id: 'self', version: null },
    name: ctx.strings.t('agent.self.name'),
    description: ctx.strings.t('agent.self.description'),
    locality: { type: 'local' },
    skills: [],
    async *sendMessage(
      request: Message,
      options?: AgentCallOptions,
    ): AsyncIterable<StreamResponse> {
      const agent = await connect();
      yield* agent.sendMessage(request, options);
    },
    cancelTask: async (taskId: string, options?: AgentCallOptions): Promise<Task> => {
      const agent = await connect();
      return agent.cancelTask(taskId, options);
    },
    getCard: async (): Promise<AgentCard> => {
      const agent = await connect();
      return agent.getCard();
    },
  };
}

/** Starts the sub-agents plugin. */
export function apply(ctx: Context, config: SubAgentsConfig | undefined): void {
  const { entities, config: settings } = ctx;
  registerEntity(ctx, selfAgent(ctx));
  registerEntity(
    ctx,
    createInvokeAgentTool({
      registry: entities,
      tasks: ctx.taskRuntime.tasks,
      state: ctx.persistence.state,
      maxDepth: settings.limits.maxAgentDepth,
    }),
  );
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const connect = async (declared: { id: string; cardUrl: string }): Promise<void> => {
    try {
      const agent = await connectRemoteAgent({
        id: declared.id,
        url: declared.cardUrl,
        allowedHosts: settings.a2a.allowedHosts,
      });
      if (!stopped) {
        registerEntity(ctx, agent);
        ctx.emit('agents/registered', declared.id);
      }
    } catch (error) {
      ctx.emit('agents/unavailable', declared.id, error);
      // A card that points where it may not is a configuration error: retrying cannot fix it.
      if (!stopped && !(error instanceof ConfigError)) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          void connect(declared);
        }, config?.retryMs ?? DEFAULT_RETRY_MS);
        timers.add(timer);
      }
    }
  };
  for (const declared of settings.agents) {
    void connect(declared);
  }
  ctx.effect(() => (): void => {
    stopped = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
  });
}
