import { describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { createCore, last } from '../support/core.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const slow = (id: string, ms: number, log: string[]): ReturnType<typeof defineTool> =>
  defineTool({
    id,
    description: id,
    inputSchema: { type: 'object' },
    invoke: async (_args, ctx) => {
      log.push(`${id} started`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          log.push(`${id} aborted`);
          resolve();
        });
      });
      return textResult(`${id} done`);
    },
  });

describe('task lifecycle', () => {
  /**
   * Feature: Task lifecycle
   * Scenario: A long-running task stays open across turns
   *   Given a task whose creator asked to keep it open
   *   When the model answers a first and then a second message
   *   Then after each answer the task waits in input-required / awaiting-next-interaction
   *   And the second answer was produced with the first exchange in context
   * Requirement: docs/specs/issue-3/requirements.md R14.2, R14.3
   */
  test('A long-running task stays open across turns', async () => {
    const core = await createCore({
      task: { longRunning: true },
      turns: [say('First answer.'), say('Second answer.')],
    });
    await core.send('One');
    const afterFirst = await core.statuses(2);
    expect(last(afterFirst)).toMatchObject({
      state: 'input-required',
      subState: 'awaiting-next-interaction',
    });
    await core.send('Two');
    const afterSecond = await core.statuses(4);
    expect(afterSecond.map((status) => status.state)).toEqual([
      'working',
      'input-required',
      'working',
      'input-required',
    ]);
    const texts = core.llm.requests[1]?.messages.flatMap((message) =>
      message.content.map((block) => (block.type === 'text' ? block.text : '')),
    );
    expect(texts).toContain('First answer.');
    expect(texts).toContain('Two');
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A client completes an open task
   *   Given a long-running task waiting for its next interaction
   *   When the client sends the complete action
   *   Then the task is completed without the model being called
   * Requirement: docs/specs/issue-3/requirements.md R14.6
   */
  test('A client completes an open task', async () => {
    const core = await createCore({ task: { longRunning: true }, turns: [say('Answer.')] });
    await core.send('One');
    await core.statuses(2);
    await core.deliver({ kind: 'action', action: 'complete' });
    expect(await core.finished).toEqual({ state: 'completed', subState: null });
    expect(core.llm.requests.length).toBe(1);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A client cancels an idle open task
   *   Given a long-running task waiting for its next interaction
   *   When the task is cancelled
   *   Then the task is recorded as canceled
   * Requirement: docs/specs/issue-3/requirements.md R14.6, R3.5
   */
  test('A client cancels an idle open task', async () => {
    const core = await createCore({ task: { longRunning: true }, turns: [say('Answer.')] });
    await core.send('One');
    await core.statuses(2);
    core.runner.cancel();
    expect(await core.finished).toEqual({ state: 'canceled', subState: null });
    expect(last(core.tasks.history)?.state).toBe('canceled');
  });

  /**
   * Feature: Task lifecycle
   * Scenario: The agent asks for input and continues on the reply
   *   Given a model that calls ask_user alongside an ordinary tool
   *   When the user replies
   *   Then the ordinary tool ran, the task waited in input-required / awaiting-user-input
   *   And the reply reached the model as the result of the ask_user call
   * Requirement: docs/specs/issue-3/requirements.md R14.5
   */
  test('The agent asks for input and continues on the reply', async () => {
    const log: string[] = [];
    const core = await createCore({
      tools: [slow('lookup', 1, log)],
      turns: [
        callTools(
          call('c1', 'lookup'),
          call('c2', 'ask_user', { question: 'Refund or store credit?' }),
        ),
        say('Refund it is.'),
      ],
    });
    await core.send('Help me');
    const waiting = await core.statuses(2);
    expect(last(waiting)).toMatchObject({
      state: 'input-required',
      subState: 'awaiting-user-input',
      message: [{ type: 'text', text: 'Refund or store credit?' }],
    });
    expect(log).toEqual(['lookup started']);
    await core.send('Refund');
    expect((await core.finished).state).toBe('completed');
    expect(await core.transcript()).toEqual([
      'user: Help me',
      'call c1: lookup',
      'call c2: ask_user',
      'result c1: lookup done',
      'result c2: Refund',
      'agent: Refund it is.',
    ]);
    const answers = core.llm.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(
      answers?.content.map((block) => (block.type === 'tool-result' ? block.callId : '')),
    ).toEqual(['c1', 'c2']);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A second question in the same reply is refused
   *   Given a model that calls ask_user twice in one response
   *   When the response is processed
   *   Then the first question is asked and the second gets an error result
   * Requirement: docs/specs/issue-3/requirements.md R14.5
   */
  test('A second question in the same reply is refused', async () => {
    const core = await createCore({
      turns: [
        callTools(
          call('c1', 'ask_user', { question: 'First?' }),
          call('c2', 'ask_user', { question: 'Second?' }),
        ),
        say('Thanks.'),
      ],
    });
    await core.send('Go');
    await core.statuses(2);
    await core.send('Answer to first');
    await core.finished;
    expect(await core.transcript()).toContain('result c2: error one-at-a-time');
    expect(await core.transcript()).toContain('result c1: Answer to first');
  });
});

describe('inbox during a turn', () => {
  /**
   * Feature: Inbox and events
   * Scenario: A message during tool execution is read at the next iteration
   *   Given a task whose tool call is in progress
   *   When a second message arrives without the interrupt mark
   *   Then the tool call finishes
   *   And the next model call sees the tool result and the second message
   *   And the task does not complete before the message is consumed
   * Requirement: docs/specs/issue-3/requirements.md R15.5
   */
  test('A message during tool execution is read at the next iteration', async () => {
    const log: string[] = [];
    const core = await createCore({
      tools: [slow('work', 40, log)],
      turns: [callTools(call('c1', 'work')), say('Saw both.')],
    });
    await core.send('Start');
    while (log.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the tool to start
      await sleep(2);
    }
    await core.send('Also this');
    await core.finished;
    expect(log).toEqual(['work started']);
    expect(await core.transcript()).toEqual([
      'user: Start',
      'call c1: work',
      'result c1: work done',
      'user: Also this',
      'agent: Saw both.',
    ]);
  });

  /**
   * Feature: Inbox and events
   * Scenario: A message that arrives as the model finishes is not skipped
   *   Given a task whose model is producing its final answer
   *   When a message arrives before the turn is closed
   *   Then the model is called again with that message
   * Requirement: docs/specs/issue-3/requirements.md R15.5
   */
  test('A message that arrives as the model finishes is not skipped', async () => {
    const core = await createCore({ turns: [say('First.'), say('Second.')], llmDelayMs: 15 });
    await core.send('One');
    await sleep(5);
    await core.send('Two');
    await core.finished;
    expect(await core.transcript()).toEqual([
      'user: One',
      'agent: First.',
      'user: Two',
      'agent: Second.',
    ]);
  });

  /**
   * Feature: Inbox and events
   * Scenario: An interrupting item aborts the current iteration
   *   Given a task whose tool call is in progress
   *   When a message marked as an interrupt arrives
   *   Then the tool call is aborted
   *   And the next model call sees the interrupted call and the new message
   * Requirement: docs/specs/issue-3/requirements.md R15.5
   */
  test('An interrupting item aborts the current iteration', async () => {
    const log: string[] = [];
    const core = await createCore({
      tools: [slow('work', 5000, log)],
      turns: [callTools(call('c1', 'work')), say('Stopped.')],
    });
    await core.send('Start');
    while (log.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the tool to start
      await sleep(2);
    }
    await core.send('Stop, do this instead', { interrupt: true });
    await core.finished;
    expect(log).toContain('work aborted');
    const shown = core.llm.requests[1]?.messages.find((message) => message.role === 'tool');
    const [block] = shown?.content ?? [];
    expect(block?.type === 'tool-result' && !block.result.ok ? block.result.error.code : '').toBe(
      'interrupted',
    );
    expect(await core.transcript()).toContain('user: Stop, do this instead');
  });

  /**
   * Feature: Inbox and events
   * Scenario: A redelivered item is consumed once
   *   Given an inbox item already moved into the conversation
   *   When the same accept step is performed again
   *   Then the conversation holds the message once
   * Requirement: docs/specs/issue-3/requirements.md R15.6
   */
  test('A redelivered item is consumed once', async () => {
    const core = await createCore({ turns: [say('Hi.')] });
    const id = await core.send('Hello');
    await core.finished;
    const [first] = await core.persistence.conversation.read(core.taskId);
    await core.handlers['conversation.accept'](
      {
        taskId: core.taskId,
        key: first?.key ?? '',
        signal: new AbortController().signal,
        outcomeUnknown: false,
      },
      { itemIds: [id] },
    );
    expect(await core.transcript()).toEqual(['user: Hello', 'agent: Hi.']);
    expect(await core.persistence.inbox.pending(core.taskId)).toEqual([]);
  });
});
