import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText, subStateOf } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

async function start(options: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  running = await startHarness(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const lifecycle = (data: Record<string, unknown>) => ({ [EXT.taskLifecycle]: data });

describe('A2A task lifecycle', () => {
  /**
   * Feature: Task lifecycle
   * Scenario: A response completes a task by default
   *   Given a harness reached through the A2A SDK client
   *   When a message that does not ask to keep the task open is sent
   *   Then the stream starts with the task, carries the answer as it is produced
   *   And ends with the task completed, with the answer stored as an artifact
   * Requirement: docs/specs/issue-3/requirements.md R13.1, R14.1, R19.2
   */
  test('A response completes a task by default', async () => {
    const harness = await start({ turns: [say('Hello from the harness.')] });
    const turn = await harness.send('Hi');
    expect(turn.events[0]?.payload?.$case).toBe('task');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(turn.streamed).toBe('Hello from the harness.');
    const stored = await harness.client.getTask({ tenant: '', id: turn.task?.id ?? '' });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(stored.artifacts.length).toBe(1);
    expect(stored.history[0]?.parts[0]?.content).toEqual({ $case: 'text', value: 'Hi' });
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A long-running task stays open across turns
   *   Given a message that creates a task and asks to keep it open
   *   When the model answers, and a second message is sent on the same task
   *   Then after each answer the task is input-required with sub-state awaiting-next-interaction
   *   And the second answer was produced with the first exchange in context
   * Requirement: docs/specs/issue-3/requirements.md R14.2, R14.3, R14.4
   */
  test('A long-running task stays open across turns', async () => {
    const harness = await start({ turns: [say('First.'), say('Second.')] });
    const first = await harness.send('One', {
      metadata: lifecycle({ longRunning: true }),
      extensions: [EXT.taskLifecycle],
    });
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(subStateOf(first.task)).toBe('awaiting-next-interaction');
    expect(statusText(first.task)).toBe('First.');

    const taskId = first.task?.id ?? '';
    const second = await harness.send('Two', { taskId, contextId: first.task?.contextId ?? '' });
    expect(second.task ?? first.task).toBeDefined();
    const stored = await harness.client.getTask({ tenant: '', id: taskId });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(statusText(stored)).toBe('Second.');
    const shown = JSON.stringify(harness.llm.requests[1]?.messages);
    expect(shown).toContain('First.');
    expect(shown).toContain('Two');
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A client completes an open task
   *   Given a long-running task waiting for its next interaction
   *   When the client sends a message whose lifecycle action is complete
   *   Then the task is completed and the model was not called for it
   * Requirement: docs/specs/issue-3/requirements.md R14.6
   */
  test('A client completes an open task', async () => {
    const harness = await start({ turns: [say('Answer.')] });
    const first = await harness.send('One', { metadata: lifecycle({ longRunning: true }) });
    const taskId = first.task?.id ?? '';
    await harness.send('', { taskId, metadata: lifecycle({ action: 'complete' }) });
    const stored = await harness.client.getTask({ tenant: '', id: taskId });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(harness.llm.requests.length).toBe(1);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A client cancels an idle open task
   *   Given a long-running task waiting for its next interaction
   *   When the client calls CancelTask
   *   Then the task is canceled
   * Requirement: docs/specs/issue-3/requirements.md R14.6
   */
  test('A client cancels an idle open task', async () => {
    const harness = await start({ turns: [say('Answer.')] });
    const first = await harness.send('One', { metadata: lifecycle({ longRunning: true }) });
    const taskId = first.task?.id ?? '';
    const canceled = await harness.client.cancelTask({
      tenant: '',
      id: taskId,
      metadata: undefined,
    });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A message to a completed task is rejected
   *   Given a task that completed
   *   When another message is sent to it
   *   Then the call fails with the specification's error and the model is not called
   * Requirement: docs/specs/issue-3/requirements.md R14.7
   */
  test('A message to a completed task is rejected', async () => {
    const harness = await start({ turns: [say('Done.')] });
    const first = await harness.send('One');
    let message = '';
    try {
      await harness.send('Again', { taskId: first.task?.id ?? '' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('terminal state');
    expect(harness.llm.requests.length).toBe(1);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: The agent asks for input and continues on the reply
   *   Given a model that calls ask_user
   *   When the user replies on the same task
   *   Then the task waited in input-required with sub-state awaiting-user-input and the question
   *   And it completed after the reply
   * Requirement: docs/specs/issue-3/requirements.md R14.5
   */
  test('The agent asks for input and continues on the reply', async () => {
    const harness = await start({
      turns: [
        callTools(call('c1', 'ask_user', { question: 'Refund or credit?' })),
        say('Refunded.'),
      ],
    });
    const first = await harness.send('Help');
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(subStateOf(first.task)).toBe('awaiting-user-input');
    expect(statusText(first.task)).toBe('Refund or credit?');
    await harness.send('Refund', { taskId: first.task?.id ?? '' });
    const stored = await harness.client.getTask({ tenant: '', id: first.task?.id ?? '' });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(statusText(stored)).toBe('Refunded.');
  });
});
