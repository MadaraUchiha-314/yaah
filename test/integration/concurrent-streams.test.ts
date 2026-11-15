import { TaskState } from '@a2a-js/sdk';
import { afterEach, describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;
let release: () => void = () => undefined;

afterEach(async () => {
  release();
  await running?.stop();
  running = undefined;
});

describe('concurrent streams of one task', () => {
  /**
   * Feature: Inbox and events
   * Scenario: A message for a working task gets a well-formed stream of its own
   *   Given a task working on a tool call, with the stream of its first message open
   *   When a second message is sent for the same task over the streaming call
   *   Then both streams begin with the task, carry only updates after it, and end
   *        without an error once the task has answered
   *   And the second message was read by the model at its next iteration
   * Requirement: docs/specs/issue-3/requirements.md R15.4, R13.1
   */
  test('A message for a working task gets a well-formed stream of its own', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running1 = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = defineTool({
      id: 'slow_lookup',
      description: 'Looks something up, slowly.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: async () => {
        started();
        await gate;
        return textResult('found');
      },
    });
    running = await startHarness({
      tools: [slow],
      turns: [callTools(call('c1', 'slow_lookup')), say('Here is everything.')],
    });
    const first = running.send('look it up');
    await running1;
    const taskId = running.llm.requests.length > 0 ? await taskIdOf(running) : '';
    const second = running.send('and also the invoice', { taskId });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    release();
    const [one, two] = await Promise.all([first, second]);
    for (const turn of [one, two]) {
      expect(turn.events[0]?.payload?.$case).toBe('task');
      expect(turn.events.slice(1).some((event) => event.payload?.$case === 'task')).toBe(false);
      expect(turn.task?.id).toBe(taskId);
    }
    expect(JSON.stringify(running.llm.requests[1])).toContain('and also the invoice');
  });
});

async function taskIdOf(harness: TestHarness): Promise<string> {
  const listed = await harness.client.listTasks({
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageSize: 10,
    pageToken: '',
    historyLength: 0,
    statusTimestampAfter: undefined,
    includeArtifacts: false,
  });
  return listed.tasks[0]?.id ?? '';
}
