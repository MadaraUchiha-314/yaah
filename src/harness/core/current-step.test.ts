import { describe, expect, test } from 'bun:test';

import { MemoryTaskPort } from '../../testing/memory-task-port.ts';
import { assertCurrent } from './current-step.ts';
import { createMemoryPersistence } from './memory-persistence.ts';

function setup(): {
  tasks: MemoryTaskPort;
  conversation: ReturnType<typeof createMemoryPersistence>['conversation'];
} {
  const tasks = new MemoryTaskPort();
  tasks.create({ taskId: 't1' });
  return { tasks, conversation: createMemoryPersistence().conversation };
}

const live = new AbortController().signal;
const step = (key: string, signal: AbortSignal = live) => ({
  taskId: 't1',
  key,
  signal,
  outcomeUnknown: false,
});
const said = (text: string) =>
  [{ type: 'message', role: 'user', parts: [{ type: 'text', text }], sourceId: text }] as const;

/** Why `work` rejects, or '' when it resolves. */
async function refusal(work: Promise<void>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('assertCurrent (self-review 1, core #10)', () => {
  test('lets a step write while nothing came after it', async () => {
    const { tasks, conversation } = setup();
    await conversation.put('t1', 't1/1/conversation.accept/', said('one'));
    expect(await refusal(assertCurrent(tasks, conversation, step('t1/3/llm.invoke/')))).toBe('');
  });

  test('stops a step whose turn a later message overtook', async () => {
    const { tasks, conversation } = setup();
    await conversation.put('t1', 't1/5/conversation.accept/', said('stop'));
    expect(await refusal(assertCurrent(tasks, conversation, step('t1/3/tool.invoke/c1')))).toBe(
      'step abandoned',
    );
  });

  test('stops a step of a task that has ended, or whose signal aborted', async () => {
    const { tasks, conversation } = setup();
    const aborted = new AbortController();
    aborted.abort(new Error('interrupted'));
    expect(
      await refusal(assertCurrent(tasks, conversation, step('t1/3/llm.invoke/', aborted.signal))),
    ).toBe('interrupted');
    await tasks.setStatus('t1', 't1/4/task.transition/', {
      state: 'canceled',
      subState: null,
      message: [],
    });
    expect(await refusal(assertCurrent(tasks, conversation, step('t1/3/llm.invoke/')))).toBe(
      'step abandoned',
    );
  });
});
