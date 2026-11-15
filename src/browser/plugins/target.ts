/**
 * The in-memory target plugin: takes the place of the HTTP listener in a build that has
 * none. Provides `ctx.harnessTarget`, through which surfaces and the `self` sub-agent
 * reach this harness's request handler without a network.
 */
import type { Client } from '@a2a-js/sdk/client';
import type { A2ARequestHandler } from '@a2a-js/sdk/server';
import type { Context } from 'cordis';

import type { HarnessTarget } from '../../app/harness-target.ts';
import { connectInMemory } from '../in-memory-transport.ts';

/** Configuration of the in-memory target plugin. */
export interface InMemoryTargetConfig {
  /** The address the agent card states. Nothing listens there. */
  readonly baseUrl?: string;
}

/** The address the agent card of a harness without a listener states. */
export const IN_MEMORY_URL = 'in-memory://yaah';

export const name = 'in-memory-target';
export const inject: readonly string[] = ['a2a'];

/** Provides the in-memory target. */
export function apply(ctx: Context, config: InMemoryTargetConfig | undefined): void {
  const baseUrl = config?.baseUrl ?? IN_MEMORY_URL;
  // Built when asked for, not now: plugins loaded after this one still add to the card.
  const handler = (): A2ARequestHandler => ctx.a2a.handlerFor(baseUrl);
  const target: HarnessTarget = {
    type: 'in-memory',
    get handler(): A2ARequestHandler {
      return handler();
    },
    connect: (): Promise<Client> => connectInMemory(handler()),
  };
  ctx.effect(() => ctx.provide('harnessTarget', target));
}
