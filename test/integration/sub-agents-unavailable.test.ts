import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentCard } from '@a2a-js/sdk';

import { apply as applySubAgents } from '../../src/harness/a2a/index.ts';
import { assertInterfaceHosts } from '../../src/harness/a2a/remote-agent.ts';
import { ConfigError } from '../../src/kernel/errors.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

const running: TestHarness[] = [];

afterEach(async () => {
  for (const harness of running.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- two harnesses at most
    await harness.stop();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const card = (...urls: string[]): AgentCard => ({
  name: 'x',
  description: 'x',
  version: '1',
  supportedInterfaces: urls.map((url) => ({
    url,
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: '1.0',
  })),
  provider: undefined,
  capabilities: undefined,
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [],
  signatures: [],
});

describe('sub-agent availability and trust', () => {
  /**
   * Feature: Security
   * Scenario: A card may only point at its own host or an allowed one
   *   Given an agent declared by the URL of its card
   *   When the card lists an interface on another host
   *   Then the agent is refused, unless the operator allowed that host
   * Requirement: docs/specs/issue-3/requirements.md abuse case 7
   */
  test('A card may only point at its own host or an allowed one', () => {
    const init = { id: 'billing', url: 'https://billing.example/.well-known/agent-card.json' };
    expect(() => {
      assertInterfaceHosts(init, card('https://billing.example/a2a'));
    }).not.toThrow();
    expect(() => {
      assertInterfaceHosts(
        init,
        card('https://billing.example/a2a', 'http://169.254.169.254/latest'),
      );
    }).toThrow(ConfigError);
    expect(() => {
      assertInterfaceHosts(
        { ...init, allowedHosts: ['rpc.example'] },
        card('https://rpc.example/a2a'),
      );
    }).not.toThrow();
  });

  /**
   * Feature: Sub-agents over A2A
   * Scenario: An unreachable agent does not stop start-up and is registered when it appears
   *   Given a harness that declares an agent whose address does not answer yet
   *   When the harness starts, and the agent comes up later
   *   Then start-up succeeds, the agent is reported unavailable, and it is registered on a retry
   * Requirement: docs/specs/issue-3/requirements.md R11.1
   */
  test('An unreachable agent does not stop start-up and is registered when it appears', async () => {
    const remote = await startHarness({ turns: [say('hi')] });
    const { url } = remote;
    await remote.stop();
    const events: string[] = [];
    const parent = await startHarness({
      config: `[[agents]]\nid = "late"\ncard_url = "${url}/.well-known/agent-card.json"\n[[overrides]]\nid = "a2a-agents"\ndisabled = true`,
      setup: async (ctx) => {
        ctx.on('agents/unavailable', (id) => {
          events.push(`unavailable ${id}`);
        });
        ctx.on('agents/registered', (id) => {
          events.push(`registered ${id}`);
        });
        // The shipped entry is disabled above so that this test can use a short retry delay.
        await ctx.inject(
          ['entities', 'config', 'strings', 'taskRuntime', 'harnessTarget'],
          (inner) => {
            applySubAgents(inner, { retryMs: 20 });
          },
        );
      },
    });
    running.push(parent);
    await waitFor(() => events.includes('unavailable late'));
    expect(parent.harness.ctx.entities.has({ kind: 'agent', id: 'late', version: null })).toBe(
      false,
    );

    const port = new URL(url).port;
    const revived = await startHarness({ turns: [say('hi')], config: `[server]\nport = ${port}` });
    running.push(revived);
    await waitFor(() => events.includes('registered late'));
    expect(parent.harness.ctx.entities.has({ kind: 'agent', id: 'late', version: null })).toBe(
      true,
    );
  });
});
