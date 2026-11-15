import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { ScriptedLlm, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;
const dirs: string[] = [];

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

  /**
   * Feature: Task lifecycle
   * Scenario: A task can be cancelled after the harness restarted
   *   Given a long-running task waiting for its next message, on a file-backed store
   *   And the harness was stopped and started again
   *   When the client cancels the task without sending it anything first
   *   Then the task is cancelled and its run has ended
   * Requirement: docs/specs/issue-3/requirements.md R14.4, R17.3 (self-review 1, core #2)
   */
  test('A task can be cancelled after the harness restarted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yaah-self-review-'));
    dirs.push(dir);
    const llm = new ScriptedLlm([say('First.')]);
    running = await startHarness({ dataDir: dir, llm });
    const first = await running.send('One', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    await running.stop();

    running = await startHarness({ dataDir: dir, llm });
    const canceled = await running.client.cancelTask({
      tenant: '',
      id: taskId,
      metadata: undefined,
    });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const { ctx } = running.harness;
    expect(ctx.taskRuntime.taskStore.open()).toEqual([]);
    // A second cancel finds the task cancelled and says so, as before.
    const again = await running.client.cancelTask({ tenant: '', id: taskId, metadata: undefined });
    expect(again.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const missing = await running.client
      .cancelTask({ tenant: '', id: 'no-such-task', metadata: undefined })
      .then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(missing).toContain('not found');
  });
});
