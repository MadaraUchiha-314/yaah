import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { ScriptedLlm, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const longRunning = { [EXT.taskLifecycle]: { longRunning: true } };

/** Waits until `read` returns something, for at most two seconds. */
async function eventually<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await sleep(5);
  }
}

/** Scenarios that came out of the self-review of the core and the service layer. */
describe('self-review findings', () => {
  /**
   * Feature: Inbox and events
   * Scenario: A message left behind by a cancelled task does not bring the task back
   *   Given a working task with a second message waiting in its inbox
   *   And the task is then cancelled
   *   When the harness next hands unconsumed inbox items to their tasks
   *   Then the task is still cancelled, the model is not called again
   *   And the message is no longer pending
   * Requirement: docs/specs/issue-3/requirements.md R15.2, R14.4 (self-review 1, core #1)
   */
  test('A message left behind by a cancelled task does not bring the task back', async () => {
    const llm = new ScriptedLlm([say('one two three four five six'), say('Back again.')], {
      delayMs: 80,
    });
    running = await startHarness({ llm });
    const { ctx } = running.harness;
    const first = running.send('One', { metadata: longRunning });
    const taskId = await eventually(() => ctx.taskRuntime.taskStore.open()[0]?.id);
    await eventually(() => (llm.requests.length === 1 ? true : undefined));
    const second = running.send('Two', { taskId });
    await eventually(async () =>
      (await ctx.persistence.inbox.pending(taskId)).length === 1 ? true : undefined,
    );
    await running.client.cancelTask({ tenant: '', id: taskId, metadata: undefined });
    await Promise.all([first, second]);
    expect(ctx.taskRuntime.taskStore.get(taskId)?.status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );

    await ctx.a2a.inbox.redeliverPending();
    await sleep(400);
    expect(ctx.taskRuntime.taskStore.get(taskId)?.status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
    expect(llm.requests).toHaveLength(1);
    expect(await ctx.persistence.inbox.pending(taskId)).toEqual([]);
  });
});
