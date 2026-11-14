import { describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { createCore, last } from '../support/core.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const echo = defineTool({
  id: 'echo',
  description: 'Echo.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: (args) => Promise.resolve(textResult(JSON.stringify(args))),
});

describe('core loop', () => {
  /**
   * Feature: Task lifecycle
   * Scenario: A response completes a task by default
   *   Given a task created without a keep-open request
   *   When the model answers and asks for no tool
   *   Then the task is completed and its result is the model's answer
   * Requirement: docs/specs/issue-3/requirements.md R3.2, R14.1
   */
  test('A response completes a task by default', async () => {
    const core = await createCore({ turns: [say('Hello there.')] });
    await core.send('Hi');
    expect(await core.finished).toEqual({ state: 'completed', subState: null });
    const final = last(core.tasks.history);
    expect(final?.isResult).toBe(true);
    expect(final?.message).toEqual([{ type: 'text', text: 'Hello there.' }]);
    expect(await core.transcript()).toEqual(['user: Hi', 'agent: Hello there.']);
    expect(core.deltas.join('')).toBe('Hello there.');
  });

  /**
   * Feature: Core loop
   * Scenario: Parallel tool calls return in order
   *   Given a model response with two tool calls, the first slower than the second
   *   When both tools have run
   *   Then they ran concurrently and the model is shown both results in call order
   * Requirement: docs/specs/issue-3/requirements.md R3.3
   */
  test('Parallel tool calls return in order', async () => {
    const running: string[] = [];
    let overlapped = false;
    const timed = (id: string, ms: number): ReturnType<typeof defineTool> =>
      defineTool({
        id,
        description: id,
        inputSchema: { type: 'object' },
        invoke: async () => {
          running.push(id);
          overlapped ||= running.length === 2;
          await sleep(ms);
          running.splice(running.indexOf(id), 1);
          return textResult(`${id} done`);
        },
      });
    const core = await createCore({
      tools: [timed('slow', 40), timed('fast', 5)],
      turns: [callTools(call('c1', 'slow'), call('c2', 'fast')), say('Both done.')],
    });
    await core.send('Go');
    await core.finished;
    expect(overlapped).toBe(true);
    const second = core.llm.requests[1];
    const results = second?.messages.find((message) => message.role === 'tool')?.content ?? [];
    expect(results.map((block) => (block.type === 'tool-result' ? block.callId : ''))).toEqual([
      'c1',
      'c2',
    ]);
  });

  /**
   * Feature: Core loop
   * Scenario: One failed tool call does not lose the others
   *   Given a model response with one call to a failing tool and one to a working tool
   *   When both have run
   *   Then the model is shown the failure for the first and the result for the second
   * Requirement: docs/specs/issue-3/requirements.md R3.4, R8.5
   */
  test('One failed tool call does not lose the others', async () => {
    const broken = defineTool({
      id: 'broken',
      description: 'x',
      inputSchema: { type: 'object' },
      invoke: () => Promise.reject(new Error('backend down')),
    });
    const core = await createCore({
      tools: [broken, echo],
      turns: [callTools(call('c1', 'broken'), call('c2', 'echo', { text: 'ok' })), say('Done.')],
    });
    await core.send('Go');
    expect((await core.finished).state).toBe('completed');
    expect(await core.transcript()).toEqual([
      'user: Go',
      'call c1: broken',
      'call c2: echo',
      'result c1: error failed',
      'result c2: {"text":"ok"}',
      'agent: Done.',
    ]);
  });

  /**
   * Feature: Security
   * Scenario: An unregistered tool is refused and reported to the model
   *   Given a model that requests a tool that is not registered
   *   When the call is processed
   *   Then nothing is invoked and the model is shown a not-found result
   * Requirement: docs/specs/issue-3/requirements.md abuse case 3
   */
  test('An unregistered tool is refused and reported to the model', async () => {
    const core = await createCore({
      turns: [callTools(call('c1', 'rm_rf', { path: '/' })), say('I cannot do that.')],
    });
    await core.send('Delete everything');
    await core.finished;
    expect(await core.transcript()).toContain('result c1: error not-found');
  });

  /**
   * Feature: Core loop
   * Scenario: The iteration limit fails the task
   *   Given a model that asks for a tool on every call
   *   When the configured number of iterations is reached
   *   Then the task fails with a reason naming the limit
   * Requirement: docs/specs/issue-3/requirements.md R3.6, abuse case 9
   */
  test('The iteration limit fails the task', async () => {
    const forever = Array.from({ length: 10 }, (_unused, index) =>
      callTools(call(`c${String(index)}`, 'echo')),
    );
    const core = await createCore({ tools: [echo], turns: forever, maxIterations: 3 });
    await core.send('Loop');
    expect((await core.finished).state).toBe('failed');
    expect(last(core.tasks.history)?.message).toEqual([
      { type: 'text', text: 'iterations limit reached (3)' },
    ]);
    expect(core.llm.requests.length).toBe(3);
  });

  /**
   * Feature: Security
   * Scenario: The task token budget fails the task before the next model call
   *   Given a model that reports large token usage on every call
   *   When the task's cumulative usage reaches its budget
   *   Then the task fails naming the limit and the model is not called again
   * Requirement: docs/specs/issue-3/requirements.md abuse case 9
   */
  test('The task token budget fails the task before the next model call', async () => {
    const core = await createCore({
      tools: [echo],
      turns: [callTools(call('c1', 'echo')), callTools(call('c2', 'echo')), say('never')],
      usagePerCall: { inputTokens: 600, outputTokens: 0 },
      maxTaskTokens: 1000,
    });
    await core.send('Spend');
    expect((await core.finished).state).toBe('failed');
    expect(last(core.tasks.history)?.message).toEqual([
      { type: 'text', text: 'tokens limit reached (1000)' },
    ]);
    expect(core.llm.requests.length).toBe(2);
  });

  /**
   * Feature: Core loop
   * Scenario: Cancel stops a working task
   *   Given a task whose model call is in progress
   *   When the task is cancelled
   *   Then no further model or tool call is issued and the task is canceled
   * Requirement: docs/specs/issue-3/requirements.md R3.5
   */
  test('Cancel stops a working task', async () => {
    const core = await createCore({
      tools: [echo],
      turns: [callTools(call('c1', 'echo')), say('never said')],
      llmDelayMs: 30,
    });
    await core.send('Go');
    await core.statuses(1);
    core.runner.cancel();
    expect(await core.finished).toEqual({ state: 'canceled', subState: null });
    expect(await core.transcript()).not.toContain('agent: never said');
  });
});
