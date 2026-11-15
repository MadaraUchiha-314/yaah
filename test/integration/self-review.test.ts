import { afterEach, describe, expect, test } from 'bun:test';
import type { StreamResponse } from '@a2a-js/sdk';
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

  /**
   * Feature: Inbox and events
   * Scenario: Resending a message that was already answered ends at once
   *   Given a long-running task waiting for its next message after message "dup-1" was answered
   *   When the client sends "dup-1" to the task again, streaming and then blocking
   *   Then each call ends promptly with the task still waiting for input
   *   And the model is not called again
   * Requirement: docs/specs/issue-3/requirements.md R15.2 (self-review 1, core #5)
   */
  test('Resending a message that was already answered ends at once', async () => {
    running = await startHarness({ turns: [say('First.'), say('never')] });
    const first = await running.send('One', { metadata: longRunning, messageId: 'dup-1' });
    const taskId = first.task?.id ?? '';
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const hung = sleep(1500).then(() => 'hung' as const);

    const again = await Promise.race([running.send('One', { taskId, messageId: 'dup-1' }), hung]);
    expect(again === 'hung' ? again : again.events.at(-1)?.payload?.$case).toBe('statusUpdate');
    const last = again === 'hung' ? undefined : again.events.at(-1)?.payload;
    expect(last?.$case === 'statusUpdate' ? last.value.status?.state : undefined).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    const blocking = await Promise.race([
      running.client.sendMessage({
        tenant: '',
        message: running.message('One', { taskId, messageId: 'dup-1' }),
        configuration: undefined,
        metadata: undefined,
      }),
      hung,
    ]);
    expect(blocking === 'hung' || !('status' in blocking) ? blocking : blocking.status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    expect(running.llm.requests).toHaveLength(1);
  });
  /**
   * Feature: Tasks
   * Scenario: A task's internal settings are not shown to callers
   *   Given a long-running task created by a caller
   *   When a client reads it with tasks/get and tasks/list, and follows its stream
   *   Then none of them carries yaah's own settings (among them the caller key) or the
   *        step that last set its status
   *   And the task model a client may read is still there
   * Requirement: docs/specs/issue-3/requirements.md Security considerations
   *   (self-review 1, core #9)
   */
  test("A task's internal settings are not shown to callers", async () => {
    running = await startHarness({ turns: [say('First.')] });
    const first = await running.send('One', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    const got = await running.client.getTask({ tenant: '', id: taskId, historyLength: undefined });
    const listed = await running.client.listTasks({
      tenant: '',
      contextId: '',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
    });
    const shown = JSON.stringify([first.events, got, listed]);
    expect(shown).not.toContain('yaah.settings');
    expect(shown).not.toContain('yaah.status-step');
    expect(got.metadata?.[EXT.taskModel]).toBeDefined();
    // The harness itself still knows who created the task.
    const stored = running.harness.ctx.taskRuntime.taskStore.get(taskId);
    expect(JSON.stringify(stored?.metadata)).toContain('yaah.settings');
  });

  /**
   * Feature: Tasks
   * Scenario: A failure to take a message for a live task leaves the task as it was
   *   Given a long-running task waiting for its next message, and a harness that knows a key
   *   And something on the way to the inbox fails, quoting the key
   *   When the client sends the task a message, streaming and then blocking
   *   Then each call fails with an error that does not contain the key
   *   And the task still waits for input and answers the next message once the failure is gone
   * Requirement: docs/specs/issue-3/requirements.md R18.4 (self-review 1, core #11)
   */
  test('A failure to take a message for a live task leaves the task as it was', async () => {
    const key = 'sk-live-feedfacecafe0001';
    running = await startHarness({
      turns: [say('First.'), say('Second.')],
      setup: (ctx) => {
        ctx.redactor.add(key);
      },
    });
    const first = await running.send('One', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    const { ctx } = running.harness;
    const remove = ctx.a2a.addInterceptor(() => Promise.reject(new Error(`store down: ${key}`)));
    const why = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const streamed = await running.send('Two', { taskId }).then(() => '', why);
    const blocking = await running.client
      .sendMessage({
        tenant: '',
        message: running.message('Two', { taskId }),
        configuration: undefined,
        metadata: undefined,
      })
      .then(() => '', why);
    for (const message of [streamed, blocking]) {
      expect(message).toContain('store down');
      expect(message).not.toContain(key);
    }
    expect(ctx.taskRuntime.taskStore.get(taskId)?.status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    remove();
    const again = await running.send('Three', { taskId });
    expect(again.streamed).toBe('Second.');
  });

  /**
   * Feature: Tasks
   * Scenario: A client that sent without waiting and then subscribes sees the whole turn
   *   Given a client sends a message with returnImmediately and gets the task back at once
   *   When the client subscribes to the task while the turn runs
   *   Then the subscription carries the answer's text and ends with the task completed
   * Requirement: docs/specs/issue-3/requirements.md R14.2 (self-review 2, #1)
   */
  test('A client that sent without waiting and then subscribes sees the whole turn', async () => {
    running = await startHarness({ turns: [say('one two three four five six')], llmDelayMs: 60 });
    const sent = await running.client.sendMessage({
      tenant: '',
      message: running.message('One'),
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
    const taskId = 'id' in sent ? sent.id : '';
    const seen: StreamResponse[] = [];
    for await (const event of running.client.resubscribeTask({ tenant: '', id: taskId })) {
      seen.push(event);
    }
    const text = seen
      .flatMap((event) =>
        event.payload?.$case === 'artifactUpdate'
          ? (event.payload.value.artifact?.parts ?? [])
          : [],
      )
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    expect(text).toContain('six');
    const last = seen.at(-1)?.payload;
    expect(last?.$case === 'statusUpdate' ? last.value.status?.state : last?.$case).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });
});
