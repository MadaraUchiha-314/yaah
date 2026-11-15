import { describe, expect, test } from 'bun:test';

import { createCore, last } from '../../../test/support/core.ts';
import { call, callTools, say } from '../../testing/scripted-llm.ts';
import { defineTool, textResult } from '../tools/types.ts';
import type { AskRoute } from './ask-routes.ts';
import { withAskRoutes } from './ask-routes.ts';
import { DirectRunner } from './direct-runner.ts';
import { runTask } from './loop.ts';

const confirm = defineTool({
  id: 'confirm',
  description: 'Asks for a confirmation.',
  inputSchema: { type: 'object' },
  invoke: () => Promise.resolve(textResult('ran as a tool')),
});

/** Claims every `confirm` call whose `ask` argument is true. */
const route: AskRoute = (_taskId, toolCall) => {
  const wanted =
    toolCall.name === 'confirm' && JSON.stringify(toolCall.args) === JSON.stringify({ ask: true });
  return Promise.resolve(wanted ? 'Are you sure?' : null);
};

/** A second run of the same task whose model call passes through `routes`. */
async function rerun(
  turns: Parameters<typeof createCore>[0],
  routes: ReadonlySet<AskRoute>,
): Promise<Awaited<ReturnType<typeof createCore>>> {
  const core = await createCore({ ...turns, task: { taskId: 'unused' } });
  core.tasks.create({ taskId: 't2' });
  const runner = new DirectRunner('t2', withAskRoutes(core.handlers, routes), {
    maxIterations: 10,
    maxTaskTokens: 1_000_000,
  });
  void runTask(runner);
  await core.persistence.inbox.put({
    id: 'q1',
    taskId: 't2',
    receivedAt: '2026-01-01T00:00:00.000Z',
    interrupt: false,
    payload: { kind: 'message', parts: [{ type: 'text', text: 'Delete it' }] },
  });
  runner.deliver({ id: 'q1', kind: 'message', interrupt: false });
  return { ...core, runner };
}

describe('ask routes', () => {
  test('a claimed call suspends the task and the reply is the result of that call', async () => {
    const core = await rerun(
      {
        turns: [callTools(call('c1', 'confirm', { ask: true })), say('Deleted.')],
        tools: [confirm],
      },
      new Set([route]),
    );
    const asked = last(await core.statuses(2));
    expect(asked?.state).toBe('input-required');
    expect(asked?.subState).toBe('awaiting-user-input');
    expect(asked?.message).toEqual([{ type: 'text', text: 'Are you sure?' }]);

    await core.persistence.inbox.put({
      id: 'a1',
      taskId: 't2',
      receivedAt: '2026-01-01T00:00:00.000Z',
      interrupt: false,
      payload: { kind: 'message', parts: [{ type: 'text', text: 'Yes' }] },
    });
    core.runner.deliver({ id: 'a1', kind: 'message', interrupt: false });
    expect(last(await core.statuses(4))?.state).toBe('completed');
    const events = await core.persistence.conversation.read('t2');
    const stored = events.find((event) => event.type === 'tool-call');
    expect(stored?.type === 'tool-call' ? stored.call.name : '').toBe('confirm');
    const result = events.find((event) => event.type === 'tool-result');
    expect(result?.type === 'tool-result' ? result.callId : '').toBe('c1');
    expect(result?.type === 'tool-result' && result.result.ok ? result.result.content : []).toEqual(
      [{ type: 'text', text: 'Yes' }],
    );
  });

  test('a call no route claims runs as the tool it is', async () => {
    const core = await rerun(
      { turns: [callTools(call('c1', 'confirm', { ask: false })), say('Done.')], tools: [confirm] },
      new Set([route]),
    );
    expect(last(await core.statuses(2))?.state).toBe('completed');
    const events = await core.persistence.conversation.read('t2');
    const result = events.find((event) => event.type === 'tool-result');
    expect(result?.type === 'tool-result' && result.result.ok ? result.result.content : []).toEqual(
      [{ type: 'text', text: 'ran as a tool' }],
    );
  });

  test('ask_user itself is never offered to a route, and no route means no change', async () => {
    const seen: string[] = [];
    const spy: AskRoute = (_taskId, toolCall) => {
      seen.push(toolCall.name);
      return Promise.resolve(null);
    };
    const asking = await rerun(
      { turns: [callTools(call('c1', 'ask_user', { question: 'Which one?' }))] },
      new Set([spy]),
    );
    expect(last(await asking.statuses(2))?.message).toEqual([{ type: 'text', text: 'Which one?' }]);
    expect(seen).toEqual([]);

    const plain = await rerun(
      { turns: [callTools(call('c1', 'confirm', { ask: true })), say('Done.')], tools: [confirm] },
      new Set(),
    );
    expect(last(await plain.statuses(2))?.state).toBe('completed');
  });
});
