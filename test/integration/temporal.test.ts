import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXT, SCHEMAS, readExtension } from '../../src/app/api-server/extensions/index.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText, subStateOf } from '../support/harness.ts';
import { freePort } from '../support/ports.ts';

let harness: TestHarness | undefined = undefined;
let dir = '';
let uiPort = 0;
const printed: string[] = [];
const llm = new ScriptedLlm([]);

function running(): TestHarness {
  if (harness === undefined) {
    throw new Error('the harness did not start');
  }
  return harness;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yaah-temporal-it-'));
  uiPort = await freePort();
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    printed.push(String(chunk));
    return write(chunk, ...rest);
  };
  try {
    harness = await startHarness({
      llm,
      dataDir: dir,
      config: [
        '[durable]',
        'mode = "temporal-embedded"',
        '[durable.temporal]',
        `port = ${String(await freePort())}`,
        `ui_port = ${String(uiPort)}`,
        `task_queue = "it-${String(Date.now())}"`,
      ].join('\n'),
    });
  } finally {
    process.stderr.write = write;
  }
}, 240_000);

afterAll(async () => {
  await harness?.stop();
  await rm(dir, { recursive: true, force: true });
}, 60_000);

const longRunning = { [EXT.taskLifecycle]: { longRunning: true } };

describe('durable execution on embedded Temporal', () => {
  /**
   * Feature: Durable execution
   * Scenario: The Temporal Web UI address is printed and in the agent card
   *   Given a harness started in a Temporal mode
   *   When it has started
   *   Then the address of the Temporal Web UI was printed at start-up
   *   And the agent card's durable-execution extension carries the mode and the same address
   * Requirement: docs/specs/issue-3/requirements.md R17.8
   */
  test('The Temporal Web UI address is printed and in the agent card', async () => {
    const expected = `http://127.0.0.1:${String(uiPort)}/namespaces/default`;
    expect(printed.join('')).toContain(`Temporal Web UI: ${expected}`);
    const card = await running().client.getAgentCard();
    const extension = card.capabilities?.extensions.find(
      (entry) => entry.uri === EXT.durableExecution,
    );
    expect(extension?.params).toEqual({ mode: 'temporal-embedded', dashboardUrl: expected });
  });

  /**
   * Feature: Durable execution
   * Scenario: Embedded mode serves the Temporal Web UI
   *   Given a harness started with embedded Temporal
   *   When the dashboard address is opened from the same machine
   *   Then the Temporal Web UI answers
   * Requirement: docs/specs/issue-3/requirements.md R17.9
   */
  test('Embedded mode serves the Temporal Web UI', async () => {
    let status = 0;
    const deadline = Date.now() + 20_000;
    while (status !== 200 && Date.now() < deadline) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the UI needs a moment after start-up
        status = (await fetch(`http://127.0.0.1:${String(uiPort)}/`)).status;
      } catch {
        status = 0;
      }
      if (status !== 200) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    }
    expect(status).toBe(200);
  }, 30_000);

  /**
   * Feature: Durable execution
   * Scenario: A long-running task runs as a workflow and carries a link to it
   *   Given a harness on embedded Temporal
   *   When a long-running task is created, answered, continued and completed by the client
   *   Then the client sees the same A2A behaviour as without Temporal
   *   And the task carries a link to its workflow in the Temporal Web UI
   * Requirement: docs/specs/issue-3/requirements.md R17.2, R17.6, R17.10, R14.2, R14.6
   */
  test('A long-running task runs as a workflow and carries a link to it', async () => {
    llm.push(say('First.'), say('Second.'));
    const first = await running().send('One', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(subStateOf(first.task)).toBe('awaiting-next-interaction');
    expect(first.streamed).toBe('First.');
    const link = readExtension(
      first.task?.metadata,
      EXT.durableExecution,
      SCHEMAS.durableExecutionTask,
    );
    expect(link?.url).toBe(
      `http://127.0.0.1:${String(uiPort)}/namespaces/default/workflows/yaah-${taskId}`,
    );

    await running().send('Two', { taskId });
    const second = await running().client.getTask({ tenant: '', id: taskId });
    expect(statusText(second)).toBe('Second.');

    await running().send('', { taskId, metadata: { [EXT.taskLifecycle]: { action: 'complete' } } });
    const done = await running().client.getTask({ tenant: '', id: taskId });
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  }, 60_000);

  /**
   * Feature: Durable execution
   * Scenario: Asking for input, parallel tools and cancel behave the same on Temporal
   *   Given a harness on embedded Temporal
   *   When the model plans with two tool calls and asks the user a question
   *   Then the task waits in input-required / awaiting-user-input and continues on the reply
   *   And an idle long-running task can be cancelled
   * Requirement: docs/specs/issue-3/requirements.md R17.6, R14.5, R3.3, R14.6
   */
  test('Asking for input, parallel tools and cancel behave the same on Temporal', async () => {
    llm.push(
      callTools(
        call('c1', 'state_set', { name: 'order', value: 'A-1041' }),
        call('c2', 'ask_user', { question: 'Refund or credit?' }),
      ),
      say('Refunded A-1041.'),
      say('Open.'),
    );
    const asked = await running().send('Help');
    expect(subStateOf(asked.task)).toBe('awaiting-user-input');
    expect(statusText(asked.task)).toBe('Refund or credit?');
    await running().send('Refund', { taskId: asked.task?.id ?? '' });
    const answered = await running().client.getTask({ tenant: '', id: asked.task?.id ?? '' });
    expect(answered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(statusText(answered)).toBe('Refunded A-1041.');

    const open = await running().send('Stay', { metadata: longRunning });
    const canceled = await running().client.cancelTask({
      tenant: '',
      id: open.task?.id ?? '',
      metadata: undefined,
    });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  }, 60_000);

  /**
   * Feature: Inbox and events
   * Scenario: An item left behind by a cancelled task is retired, not delivered
   *   Given a task that was cancelled, with an item still unconsumed in its inbox
   *   When the harness hands unconsumed inbox items to their tasks again
   *   Then the task is still cancelled and the model is not called
   *   And the item is no longer pending
   * Requirement: docs/specs/issue-3/requirements.md R15.2, R14.4 (self-review 1, core #1)
   */
  test('An item left behind by a cancelled task is retired, not delivered', async () => {
    llm.push(say('Open.'), say('Back again.'));
    const { ctx } = running().harness;
    const open = await running().send('Stay', { metadata: longRunning });
    const taskId = open.task?.id ?? '';
    await running().client.cancelTask({ tenant: '', id: taskId, metadata: undefined });
    const calls = llm.requests.length;
    await ctx.persistence.inbox.put({
      id: `${taskId}:left-behind`,
      taskId,
      receivedAt: new Date().toISOString(),
      interrupt: false,
      payload: { kind: 'message', parts: [{ type: 'text', text: 'Too late' }] },
    });

    await ctx.a2a.inbox.redeliverPending();
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
    const stored = await running().client.getTask({ tenant: '', id: taskId });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(llm.requests).toHaveLength(calls);
    expect(await ctx.persistence.inbox.pending(taskId)).toEqual([]);
  }, 60_000);
});
