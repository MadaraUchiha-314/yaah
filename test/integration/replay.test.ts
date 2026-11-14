import { describe, expect, test } from 'bun:test';

import { DirectRunner } from '../../src/harness/core/direct-runner.ts';
import { runTask } from '../../src/harness/core/loop.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { createCore } from '../support/core.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('journal replay', () => {
  /**
   * Feature: Durable execution
   * Scenario: A restarted run resumes without repeating a recorded step
   *   Given a long-running task that answered one turn and is waiting
   *   When a new run is started for the same task over the same stores
   *   Then no model or tool call of the first turn is made again
   *   And the next message is answered with the first turn in context
   * Requirement: docs/specs/issue-3/requirements.md R5.4, R17.3
   */
  test('A restarted run resumes without repeating a recorded step', async () => {
    let toolRuns = 0;
    const counted = defineTool({
      id: 'counted',
      description: 'x',
      inputSchema: { type: 'object' },
      invoke: () => {
        toolRuns += 1;
        return Promise.resolve(textResult('ran'));
      },
    });
    const core = await createCore({
      journaled: true,
      task: { longRunning: true },
      tools: [counted],
      turns: [callTools(call('c1', 'counted')), say('First answer.'), say('Second answer.')],
    });
    await core.send('One');
    await core.statuses(2);
    expect(toolRuns).toBe(1);
    expect(core.llm.requests.length).toBe(2);

    // "Restart": abandon the first runner and replay the task on a fresh one.
    const restarted = new DirectRunner(core.taskId, core.handlers, core.runner.limits, {
      journal: core.persistence.journal,
    });
    const finished = runTask(restarted);
    await sleep(20);
    expect(toolRuns).toBe(1);
    expect(core.llm.requests.length).toBe(2);
    expect(core.tasks.history.length).toBe(2);

    await core.persistence.inbox.put({
      id: 'm-after',
      taskId: core.taskId,
      receivedAt: '2026-01-01T00:00:00.000Z',
      interrupt: false,
      payload: { kind: 'message', parts: [{ type: 'text', text: 'Two' }] },
    });
    restarted.deliver({ id: 'm-after', kind: 'message', interrupt: false });
    await core.statuses(4);
    expect(await core.transcript()).toEqual([
      'user: One',
      'call c1: counted',
      'result c1: ran',
      'agent: First answer.',
      'user: Two',
      'agent: Second answer.',
    ]);
    restarted.cancel();
    await finished;
  });

  /**
   * Feature: Durable execution
   * Scenario: An item the first run already read is not consumed twice after a restart
   *   Given a task whose first message was read and answered
   *   When the run restarts and the same item is delivered again
   *   Then the conversation holds the message once
   * Requirement: docs/specs/issue-3/requirements.md R15.6
   */
  test('An item the first run already read is not consumed twice after a restart', async () => {
    const core = await createCore({
      journaled: true,
      task: { longRunning: true },
      turns: [say('Answer.')],
    });
    const id = await core.send('Only once');
    await core.statuses(2);
    const restarted = new DirectRunner(core.taskId, core.handlers, core.runner.limits, {
      journal: core.persistence.journal,
    });
    const finished = runTask(restarted);
    restarted.deliver({ id, kind: 'message', interrupt: false });
    await sleep(20);
    expect(await core.transcript()).toEqual(['user: Only once', 'agent: Answer.']);
    expect(core.llm.requests.length).toBe(1);
    restarted.cancel();
    await finished;
  });

  /**
   * Feature: Durable execution
   * Scenario: An interrupted iteration replays as interrupted
   *   Given a task whose tool call was aborted by an interrupting message
   *   When the run restarts
   *   Then the aborted tool is not run again and the conversation is unchanged
   * Requirement: docs/specs/issue-3/requirements.md R15.5, R17.3
   */
  test('An interrupted iteration replays as interrupted', async () => {
    let starts = 0;
    let started = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hang = defineTool({
      id: 'hang',
      description: 'x',
      inputSchema: { type: 'object' },
      invoke: (_args, ctx) =>
        new Promise((resolve) => {
          starts += 1;
          started();
          ctx.signal.addEventListener('abort', () => {
            resolve(textResult('aborted'));
          });
        }),
    });
    const core = await createCore({
      journaled: true,
      task: { longRunning: true },
      tools: [hang],
      turns: [callTools(call('c1', 'hang')), say('Stopped.')],
    });
    await core.send('Start');
    await running;
    await core.send('Stop', { interrupt: true });
    await core.statuses(2);
    const before = await core.transcript();

    const restarted = new DirectRunner(core.taskId, core.handlers, core.runner.limits, {
      journal: core.persistence.journal,
    });
    const finished = runTask(restarted);
    await sleep(20);
    expect(starts).toBe(1);
    expect(await core.transcript()).toEqual(before);
    expect(core.llm.requests.length).toBe(2);
    restarted.cancel();
    await finished;
  });
});
