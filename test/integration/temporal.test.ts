import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, Connection } from '@temporalio/client';

import { EXT, SCHEMAS, readExtension } from '../../src/app/api-server/extensions/index.ts';
import { LlmError } from '../../src/harness/models/llm/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText, subStateOf } from '../support/harness.ts';
import { freePort } from '../support/ports.ts';

let harness: TestHarness | undefined = undefined;
let dir = '';
let uiPort = 0;
let temporalPort = 0;
const printed: string[] = [];
const llm = new ScriptedLlm([]);
/** A tool that takes its time and does not stop when asked: the step must not write. */
const slow = defineTool({
  id: 'slow',
  description: 'Takes a while.',
  inputSchema: { type: 'object' },
  retrySafe: true,
  invoke: () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(textResult('slow result'));
      }, 1500);
    }),
});

function running(): TestHarness {
  if (harness === undefined) {
    throw new Error('the harness did not start');
  }
  return harness;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yaah-temporal-it-'));
  uiPort = await freePort();
  temporalPort = await freePort();
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    printed.push(String(chunk));
    return write(chunk, ...rest);
  };
  try {
    harness = await startHarness({
      llm,
      tools: [slow],
      dataDir: dir,
      config: [
        '[durable]',
        'mode = "temporal-embedded"',
        '[durable.temporal]',
        `port = ${String(temporalPort)}`,
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
   * Feature: Durable execution
   * Scenario: A step an interrupt abandoned writes nothing on Temporal
   *   Given a harness on embedded Temporal and a tool call that takes a while
   *   When an interrupting message arrives while the call runs, and the call then finishes
   *   Then the tool's result is not written into the conversation after the new message
   *   And the model answers the new message
   * Requirement: docs/specs/issue-3/requirements.md R15.5, R17.6 (self-review 1, core #10)
   */
  test('A step an interrupt abandoned writes nothing on Temporal', async () => {
    llm.push(callTools(call('s1', 'slow')), say('Stopped.'));
    const { ctx } = running().harness;
    const first = running().send('Work', { metadata: longRunning });
    const deadline = Date.now() + 20_000;
    let taskId = '';
    while (taskId === '' && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the call to start
      const events = await Promise.all(
        ctx.taskRuntime.taskStore.open().map(async (task) => ({
          id: task.id,
          events: await ctx.persistence.conversation.read(task.id),
        })),
      );
      taskId = events.find((task) => task.events.some((e) => e.type === 'tool-call'))?.id ?? '';
      // oxlint-disable-next-line no-await-in-loop -- waiting for the call to start
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    const stop = running().send('Stop', {
      taskId,
      metadata: { [EXT.inboxEvents]: { interrupt: true } },
    });
    await Promise.all([first, stop]);
    // Give the abandoned call time to finish and try to write.
    await new Promise((resolve) => {
      setTimeout(resolve, 2500);
    });
    const events = await ctx.persistence.conversation.read(taskId);
    expect(events.some((event) => event.type === 'tool-result' && event.callId === 's1')).toBe(
      false,
    );
    const stored = await running().client.getTask({ tenant: '', id: taskId });
    expect(statusText(stored)).toBe('Stopped.');
  }, 60_000);

  /**
   * Feature: Security
   * Scenario: A credential in a failing step reaches neither Temporal's history nor its log
   *   Given a harness on embedded Temporal that knows a credential
   *   And a model whose failure message and cause quote that credential
   *   When a task's model step fails
   *   Then the task fails
   *   And the credential is absent from the workflow's history and from what the worker logged
   * Requirement: docs/specs/issue-3/requirements.md R18.4 (critic 1, #2)
   */
  test('A credential in a failing step reaches neither the history nor the log', async () => {
    const secret = 'sk-synthetic-temporal-0123456789';
    expect(llm.remaining).toBe(0);
    const { ctx } = running().harness;
    ctx.redactor.add(secret);
    llm.push({
      error: new LlmError(
        'scripted',
        'scripted',
        false,
        `rejected key ${secret}`,
        new Error(`upstream echoed ${secret}`),
      ),
    });
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]): boolean => {
      logged.push(String(chunk));
      return write(chunk, ...rest);
    };
    let history = '';
    try {
      const failed = await running().send('Fail');
      expect(failed.task?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      const connection = await Connection.connect({ address: `127.0.0.1:${String(temporalPort)}` });
      try {
        const client = new Client({ connection });
        const handle = client.workflow.getHandle(`yaah-${failed.task?.id ?? ''}`);
        const events = await handle.fetchHistory();
        history = JSON.stringify(events, (_key, value: unknown) =>
          value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
        );
      } finally {
        await connection.close();
      }
    } finally {
      process.stderr.write = write;
    }
    expect(history).toContain('[redacted]');
    expect(history).not.toContain(secret);
    expect(logged.join('')).toContain('Activity failed');
    expect(logged.join('')).not.toContain(secret);
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
