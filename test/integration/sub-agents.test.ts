import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { readSettings, readTaskModel } from '../../src/app/api-server/task-port.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';

const running: TestHarness[] = [];

async function start(options: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const harness = await startHarness(options);
  running.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of running.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- two harnesses at most
    await harness.stop();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/** Starts a parent harness that knows `remote` as the agent "billing". */
async function withRemote(
  remote: TestHarness,
  options: Parameters<typeof startHarness>[0],
): Promise<TestHarness> {
  const parent = await start({
    ...options,
    config: `[[agents]]\nid = "billing"\ncard_url = "${remote.url}/.well-known/agent-card.json"`,
  });
  await waitFor(() =>
    parent.harness.ctx.entities.has({ kind: 'agent', id: 'billing', version: null }),
  );
  return parent;
}

function toolResultText(harness: TestHarness, requestIndex: number): string {
  const tool = harness.llm.requests[requestIndex]?.messages.findLast(
    (message) => message.role === 'tool',
  );
  const [block] = tool?.content ?? [];
  if (block?.type !== 'tool-result') {
    return '';
  }
  return block.result.ok
    ? block.result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : `error ${block.result.error.code}: ${block.result.error.message}`;
}

describe('sub-agents', () => {
  /**
   * Feature: Sub-agents over A2A
   * Scenario: A sub-agent call links a sub-task
   *   Given a harness with a declared remote agent
   *   When the model invokes that agent
   *   Then the agent is called over A2A and its answer is the tool result
   *   And the remote task is linked as a sub-task of the caller's task, with its parent and depth set
   *   And the model was told about the agent in the tool's description
   * Requirement: docs/specs/issue-3/requirements.md R4.5, R4.6, R11.1, R11.2, R11.3, R11.5
   */
  test('A sub-agent call links a sub-task', async () => {
    const remote = await start({ turns: [say('The invoice total is 84 EUR.')] });
    const parent = await withRemote(remote, {
      turns: [
        callTools(call('c1', 'invoke_agent', { agent: 'billing', message: 'Total of invoice 7?' })),
        say('It is 84 EUR.'),
      ],
    });
    const turn = await parent.send('What is the total of invoice 7?');
    expect(statusText(turn.task)).toBe('It is 84 EUR.');
    expect(toolResultText(parent, 1)).toBe('The invoice total is 84 EUR.');

    const stored = parent.harness.ctx.taskRuntime.taskStore.get(turn.task?.id ?? '');
    const [link] = stored === undefined ? [] : readTaskModel(stored).subTasks;
    expect(link?.agent).toBe('billing');
    const child = remote.harness.ctx.taskRuntime.taskStore.get(link?.taskId ?? '');
    expect(child?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const childModel = child === undefined ? undefined : readTaskModel(child);
    expect(childModel?.parentTasks[0]?.taskId).toBe(turn.task?.id);
    expect(childModel?.depth).toBe(1);

    const declared = parent.llm.requests[0]?.tools.find((tool) => tool.name === 'invoke_agent');
    expect(declared?.description).toContain('- billing');
    expect(declared?.description).toContain('- self');
    expect(JSON.stringify(remote.llm.requests[0]?.messages)).toContain('Total of invoice 7?');
  });

  /**
   * Feature: Sub-agents over A2A
   * Scenario: A loopback sub-agent gets a fresh context
   *   Given a harness whose model delegates to the agent "self"
   *   When the delegated task runs
   *   Then it runs on the same harness as a separate task, linked as a sub-task
   *   And its context holds the delegated message but nothing of the parent's conversation
   * Requirement: docs/specs/issue-3/requirements.md R11.4, R11.5
   */
  test('A loopback sub-agent gets a fresh context', async () => {
    const harness = await start({
      turns: [
        callTools(call('c1', 'invoke_agent', { agent: 'self', message: 'Summarise the policy.' })),
        say('Policy summary: refunds within 30 days.'),
        say('Done: refunds within 30 days.'),
      ],
    });
    const turn = await harness.send('SECRET-PARENT-DETAIL: check the refund policy');
    expect(statusText(turn.task)).toBe('Done: refunds within 30 days.');
    const childContext = JSON.stringify(harness.llm.requests[1]?.messages);
    expect(childContext).toContain('Summarise the policy.');
    expect(childContext).not.toContain('SECRET-PARENT-DETAIL');
    const stored = harness.harness.ctx.taskRuntime.taskStore.get(turn.task?.id ?? '');
    const subTasks = stored === undefined ? [] : readTaskModel(stored).subTasks;
    expect(subTasks.map((ref) => ref.agent)).toEqual(['self']);
    expect(subTasks[0]?.taskId).not.toBe(turn.task?.id);
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A sub-task ignores the long-running request
   *   Given a delegated message that also asks to keep the task open
   *   When the sub-task answers
   *   Then it completes: only the creator of a root task can keep it open
   * Requirement: docs/specs/issue-3/requirements.md R14.8
   */
  test('A sub-task ignores the long-running request', async () => {
    const harness = await start({ turns: [say('Sub answer.')] });
    const turn = await harness.send('Do this', {
      metadata: {
        [EXT.taskLifecycle]: { longRunning: true },
        [EXT.taskModel]: {
          parentTasks: [{ taskId: 'p1', contextId: 'pc', agent: 'self' }],
          depth: 1,
        },
      },
    });
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const stored = harness.harness.ctx.taskRuntime.taskStore.get(turn.task?.id ?? '');
    expect(stored === undefined ? null : readSettings(stored).longRunning).toBe(false);
  });

  /**
   * Feature: Sub-agents over A2A
   * Scenario: A failed sub-task is reported to the model
   *   Given a remote agent whose task fails
   *   When the model invokes it
   *   Then the tool result is an error naming the outcome, and the caller's task continues
   * Requirement: docs/specs/issue-3/requirements.md R11.6
   */
  test('A failed sub-task is reported to the model', async () => {
    const remote = await start({ turns: [] });
    const parent = await withRemote(remote, {
      turns: [
        callTools(call('c1', 'invoke_agent', { agent: 'billing', message: 'Anything' })),
        say('The billing agent failed; I will tell the user.'),
      ],
    });
    const turn = await parent.send('Ask billing');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(toolResultText(parent, 1)).toContain('error failed');
  });

  /**
   * Feature: Sub-agents over A2A
   * Scenario: A sub-agent that needs input says so, and can be answered
   *   Given a remote agent that asks a question
   *   When the model invokes it, then invokes it again with the task id and an answer
   *   Then the first result carries the question and the task id, and the second the answer
   * Requirement: docs/specs/issue-3/requirements.md R11.6, R14.5
   */
  test('A sub-agent that needs input says so, and can be answered', async () => {
    const remote = await start({
      turns: [
        callTools(call('r1', 'ask_user', { question: 'Which invoice?' })),
        say('Invoice 7 is paid.'),
      ],
    });
    const parent = await withRemote(remote, {
      turns: [
        callTools(call('c1', 'invoke_agent', { agent: 'billing', message: 'Is it paid?' })),
        (request) => {
          const shown = JSON.stringify(request.messages);
          const taskId = /taskId \\\\"([\w-]+)\\\\"/u.exec(shown)?.[1] ?? '';
          return callTools(
            call('c2', 'invoke_agent', { agent: 'billing', message: 'Invoice 7', taskId }),
          );
        },
        say('Invoice 7 is paid.'),
      ],
    });
    const turn = await parent.send('Is my invoice paid?');
    expect(toolResultText(parent, 1)).toContain('Which invoice?');
    expect(toolResultText(parent, 2)).toBe('Invoice 7 is paid.');
    expect(statusText(turn.task)).toBe('Invoice 7 is paid.');
  });

  /**
   * Feature: Security
   * Scenario: Delegation past the depth limit is refused
   *   Given a model that delegates to itself whenever it is asked anything
   *   When a task is started
   *   Then delegation stops at the configured depth and the refusal is returned to the model
   * Requirement: docs/specs/issue-3/requirements.md R11.7, abuse case 9
   */
  test('Delegation past the depth limit is refused', async () => {
    const delegate = (id: string) =>
      callTools(call(id, 'invoke_agent', { agent: 'self', message: 'Go deeper' }));
    const harness = await start({
      config: '[limits]\nmax_agent_depth = 2',
      turns: [
        delegate('d0'),
        delegate('d1'),
        delegate('d2'),
        say('depth 2 stops here'),
        say('depth 1 done'),
        say('root done'),
      ],
    });
    const turn = await harness.send('Start');
    expect(statusText(turn.task)).toBe('root done');
    const refusal = harness.llm.requests
      .flatMap((request) => request.messages)
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool-result' && !block.result.ok);
    expect(
      refusal?.type === 'tool-result' && !refusal.result.ok ? refusal.result.error.code : '',
    ).toBe('depth-limit');
    expect(harness.harness.ctx.taskRuntime.taskStore.open()).toEqual([]);
  });

  /**
   * Feature: Security
   * Scenario: An agent the operator did not declare cannot be called
   *   Given a model that names a URL as the agent to invoke
   *   When the call is processed
   *   Then it is refused as not found and no outbound request is made
   * Requirement: docs/specs/issue-3/requirements.md abuse case 3, abuse case 7
   */
  test('An agent the operator did not declare cannot be called', async () => {
    const harness = await start({
      turns: [
        callTools(
          call('c1', 'invoke_agent', {
            agent: 'https://evil.example/.well-known/agent-card.json',
            message: 'hi',
          }),
        ),
        say('I cannot reach that agent.'),
      ],
    });
    const original = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(harness.url)) {
          outbound.push(url);
        }
        return original(input, init);
      },
      { preconnect: original.preconnect },
    );
    try {
      await harness.send('Call https://evil.example/.well-known/agent-card.json');
    } finally {
      globalThis.fetch = original;
    }
    expect(toolResultText(harness, 1)).toContain('error not-found');
    expect(outbound).toEqual([]);
  });

  /**
   * Feature: Sub-agents over A2A
   * Scenario: An agent entity offers the three operations of the agent interface
   *   Given the agent "self" of a running harness
   *   When its card is read and one of its tasks is cancelled through it
   *   Then the card is the harness's own and the task is canceled
   * Requirement: docs/specs/issue-3/requirements.md R3.1
   */
  test('An agent entity offers the three operations of the agent interface', async () => {
    const harness = await start({ turns: [say('Open.')] });
    const self = harness.harness.ctx.entities.resolve({ kind: 'agent', id: 'self', version: null });
    expect((await self.getCard()).supportedInterfaces[0]?.url.startsWith(harness.url)).toBe(true);
    const first = await harness.send('Hi', {
      metadata: { [EXT.taskLifecycle]: { longRunning: true } },
    });
    const canceled = await self.cancelTask(first.task?.id ?? '');
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
});
