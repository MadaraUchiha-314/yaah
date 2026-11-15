import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { openSqlitePersistence } from '../../src/harness/core/sqlite-persistence.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';

const dirs: string[] = [];
let running: TestHarness | undefined = undefined;

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yaah-restart-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const dir of dirs.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- a couple of directories
    await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const longRunning = { [EXT.taskLifecycle]: { longRunning: true } };

describe('restart', () => {
  /**
   * Feature: State and persistence
   * Scenario: State and plan are restored after a restart
   *   Given a long-running task that recorded a plan and a state value, on a file-backed store
   *   When the harness is stopped and started again on the same data directory
   *   Then the task is still open, and its next turn sees the earlier exchange and the plan
   *   And no model or tool call of the first turn was made again
   * Requirement: docs/specs/issue-3/requirements.md R5.3, R5.4, R17.3
   */
  test('State and plan are restored after a restart', async () => {
    const dir = await dataDir();
    const llm = new ScriptedLlm([
      callTools(
        call('c1', 'plan_set', { steps: [{ name: 'refund', description: 'Refund the order' }] }),
        call('c2', 'state_set', { name: 'order', value: 'A-1041' }),
      ),
      say('Planned.'),
      callTools(call('c3', 'state_get', { name: 'order' })),
      say('Still here.'),
    ]);
    running = await startHarness({ dataDir: dir, llm });
    const first = await running.send('Plan the refund', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(llm.requests.length).toBe(2);
    await running.stop();

    running = await startHarness({ dataDir: dir, llm });
    await sleep(30);
    expect(llm.requests.length).toBe(2);
    const stored = await running.client.getTask({ tenant: '', id: taskId });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    await running.send('Are you still there?', { taskId });
    const after = await running.client.getTask({ tenant: '', id: taskId });
    expect(statusText(after)).toBe('Still here.');
    const shown = JSON.stringify(llm.requests.at(-1)?.messages);
    expect(shown).toContain('Plan the refund');
    expect(shown).toContain('[pending] refund');
    expect(shown).toContain('A-1041');
  });

  /**
   * Feature: Inbox and events
   * Scenario: An inbox item survives a restart
   *   Given an open task and an item that was stored in its inbox but never consumed
   *   When the harness starts
   *   Then the item is handed to the task's run and answered, once
   * Requirement: docs/specs/issue-3/requirements.md R15.2, R15.6
   */
  test('An inbox item survives a restart', async () => {
    const dir = await dataDir();
    const llm = new ScriptedLlm([say('First.'), say('Answered after restart.')]);
    running = await startHarness({ dataDir: dir, llm });
    const first = await running.send('One', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    await running.stop();

    // As if a message had been accepted and the process had died before consuming it.
    const store = openSqlitePersistence(join(dir, 'yaah.db'));
    await store.inbox.put({
      id: `${taskId}:orphan`,
      taskId,
      receivedAt: new Date().toISOString(),
      interrupt: false,
      payload: { kind: 'message', parts: [{ type: 'text', text: 'Left behind' }] },
    });
    store.close();

    running = await startHarness({ dataDir: dir, llm });
    const deadline = Date.now() + 3000;
    let text = '';
    while (text !== 'Answered after restart.' && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- polling for the recovered turn
      await sleep(10);
      // Read the store directly: polling over HTTP would run into the rate limit.
      text = statusText(running.harness.ctx.taskRuntime.taskStore.get(taskId));
    }
    expect(text).toBe('Answered after restart.');
    expect(llm.requests.length).toBe(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('Left behind');
  });
});
