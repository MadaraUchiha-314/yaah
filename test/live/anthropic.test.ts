import { afterEach, describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import type { Harness } from '../../src/kernel/bootstrap.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { ensureKey } from './keys.ts';

const MODEL = process.env['YAAH_LIVE_ANTHROPIC_MODEL'] ?? 'claude-haiku-5-5';
const hasModel = ensureKey('ANTHROPIC_API_KEY', 'anthropic');
const live = hasModel ? test : test.skip;
/** The project's Temporal Cloud namespace; override with the two variables to use another. */
const TEMPORAL = {
  address: process.env['YAAH_LIVE_TEMPORAL_ADDRESS'] ?? 'yaah.gtebu.tmprl.cloud:7233',
  namespace: process.env['YAAH_LIVE_TEMPORAL_NAMESPACE'] ?? 'yaah.gtebu',
};
const cloud = hasModel && ensureKey('TEMPORAL_API_KEY', 'temporal') ? test : test.skip;

let harness: Harness | undefined = undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function last(views: AsyncIterable<TaskView>): Promise<TaskView> {
  let final: TaskView | undefined = undefined;
  for await (const view of views) {
    final = view;
  }
  if (final === undefined) {
    throw new Error('the turn produced no view');
  }
  return final;
}

const agentText = (view: TaskView): string =>
  view.items
    .filter((item) => item.kind === 'agent' || item.kind === 'ask')
    .map((item) => item.text)
    .join('\n');

describe('live: Anthropic', () => {
  /**
   * Feature: Live providers
   * Scenario: A real model works a long-running task with a tool across two turns
   *   Given a harness using a Claude model through the Anthropic plugin and one tool
   *   When the user asks about an order, and then asks a follow-up in the same task
   *   Then the model calls the tool with the order id, its first answer uses what the
   *        tool returned, the follow-up is answered from the same conversation without
   *        a second tool call being required, and the client completes the task
   * Requirement: docs/specs/issue-3/requirements.md R6.2, R8.1, R14.1–14.4, R27.2
   */
  const scenario = async (extraConfig: readonly string[]): Promise<TaskView> => {
    const lookups: string[] = [];
    const lookup = defineTool({
      id: 'lookup_order',
      description: 'Looks up an order by its id and returns its status.',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
        additionalProperties: false,
      },
      retrySafe: true,
      invoke: (args) => {
        lookups.push(JSON.stringify(args));
        return Promise.resolve(
          textResult('Order A-1041: one ceramic lamp, delivered on 9 November to Lisbon.'),
        );
      },
    });
    harness = await createHarness({
      config: parseConfig(
        [
          'composition = "server"',
          'data_dir = ":memory:"',
          `model = { llm = "anthropic/${MODEL}", effort = "low" }`,
          '[server]',
          'port = 0',
          '[o11y]',
          'log_level = "error"',
          '[[overrides]]',
          'id = "web-ui"',
          'disabled = true',
          ...extraConfig,
        ].join('\n'),
        'live.toml',
      ),
      setup: (ctx) => {
        registerEntity(ctx, lookup);
      },
    });
    const session = await HarnessSession.connect(harness.ctx.http.url, { longRunning: true });
    const first = await last(session.send({ text: 'Where is my order A-1041?' }));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('A-1041');
    expect(first.items.some((item) => item.kind === 'tool' && item.name === 'lookup_order')).toBe(
      true,
    );
    expect(agentText(first).toLowerCase()).toContain('lamp');
    expect(first.state).toBe('awaiting-next-interaction');

    const second = await last(session.send({ text: 'Which city was it delivered to?' }, first));
    expect(second.taskId).toBe(first.taskId);
    expect(agentText(second)).toContain('Lisbon');

    const done = await session.complete(second);
    expect(done.state).toBe('completed');
    return done;
  };

  live(
    'A real model works a long-running task with a tool across two turns',
    async () => {
      await scenario([]);
    },
    120_000,
  );

  /**
   * Feature: Live providers
   * Scenario: The same task runs as a workflow on embedded Temporal
   *   Given the harness in mode `temporal-embedded`, with a real Claude model
   *   When the two-turn task with a tool call is worked and completed
   *   Then it behaves as in the in-process mode, and the task links to its workflow in
   *        the local Temporal Web UI
   * Requirement: docs/specs/issue-3/requirements.md R17.2, R17.8, R27.4
   */
  live(
    'The same task runs as a workflow on embedded Temporal',
    async () => {
      const done = await scenario([
        '[durable]',
        'mode = "temporal-embedded"',
        '[durable.temporal]',
        'port = 17233',
        'ui_port = 18233',
      ]);
      expect(done.workflowUrl).toContain('http://127.0.0.1:18233/');
      expect((await fetch(done.workflowUrl ?? '')).status).toBe(200);
    },
    180_000,
  );

  /**
   * Feature: Live providers
   * Scenario: The same task runs as a workflow on Temporal Cloud
   *   Given the harness in mode `temporal-remote` against the project's Temporal Cloud
   *        namespace, with a real Claude model
   *   When the two-turn task with a tool call is worked and completed
   *   Then it behaves as in the in-process mode, and the task links to its workflow in
   *        the Temporal Cloud UI
   * Requirement: docs/specs/issue-3/requirements.md R17.3, R17.8, R27.4
   */
  cloud(
    'The same task runs as a workflow on Temporal Cloud',
    async () => {
      const done = await scenario([
        '[durable]',
        'mode = "temporal-remote"',
        '[durable.temporal]',
        `address = "${TEMPORAL.address}"`,
        `namespace = "${TEMPORAL.namespace}"`,
        `task_queue = "yaah-live-${String(Date.now())}"`,
      ]);
      expect(done.workflowUrl).toContain(TEMPORAL.namespace);
    },
    180_000,
  );
});
