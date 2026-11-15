import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import type { ToolResult } from '../../src/harness/core/types.ts';
import type { LlmRequest } from '../../src/harness/models/llm/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { fakeAgent } from '../support/channels.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function toolResults(request: LlmRequest | undefined): ToolResult[] {
  return (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool-result' ? [block.result] : [])),
  );
}

/** A tool that records each time it runs. */
function recording(id: string, ran: string[]) {
  return defineTool({
    id,
    description: `Records a call to ${id}.`,
    inputSchema: { type: 'object' },
    invoke: (args) => {
      ran.push(`${id}:${JSON.stringify(args)}`);
      return Promise.resolve(textResult(`${id} done`));
    },
  });
}

describe('hooks', () => {
  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A programmatic hook denies a tool call
   *   Given two hooks registered from code on tool.before, the second for tools matching
   *         "wire_*" and denying with a reason that holds a credential
   *   When the model calls wire_money and, beside it, read_balance
   *   Then both hooks ran in registration order for wire_money
   *   And wire_money did not run; its result tells the model it was denied and why, redacted
   *   And read_balance ran, and the task completes
   *   And when the hook is removed, wire_money runs
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A programmatic hook denies a tool call', async () => {
    const ran: string[] = [];
    const order: string[] = [];
    let remove: () => void = () => undefined;
    running = await startHarness({
      tools: [recording('wire_money', ran), recording('read_balance', ran)],
      setup: (ctx) => {
        ctx.redactor.add('sk-hook-secret-456');
        ctx.hooks.register('tool.before', {
          run: (event) => void order.push(`first:${event.tool}`),
        });
        remove = ctx.hooks.register('tool.before', {
          match: 'wire_*',
          run: (event) => {
            order.push(`second:${event.tool}`);
            return { decision: 'deny', reason: 'over the limit (sk-hook-secret-456)' };
          },
        });
      },
      turns: [
        callTools(call('c1', 'wire_money', { amount: 9000 }), call('c2', 'read_balance')),
        say('The transfer was not allowed.'),
        callTools(call('c3', 'wire_money', { amount: 1 })),
        say('Sent.'),
      ],
    });
    const turn = await running.send('Wire 9000.');
    // The two calls run side by side; the order is fixed within a call.
    expect(order.filter((entry) => entry.endsWith('wire_money'))).toEqual([
      'first:wire_money',
      'second:wire_money',
    ]);
    expect(order.filter((entry) => entry.endsWith('read_balance'))).toEqual(['first:read_balance']);
    expect(ran).toEqual(['read_balance:{}']);
    expect(toolResults(running.llm.requests[1])).toEqual([
      {
        ok: false,
        error: {
          code: 'denied',
          message:
            'The call to wire_money was denied by a hook and did not run: over the limit ([redacted])',
        },
      },
      { ok: true, content: [{ type: 'text', text: 'read_balance done' }] },
    ]);
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    remove();
    await running.send('Wire 1.');
    expect(ran).toEqual(['read_balance:{}', 'wire_money:{"amount":1}']);
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A hook that throws denies, and is logged
   *   Given a tool.before hook that throws
   *   When the model calls a tool
   *   Then the tool does not run, the model is told the hook failed, and the task goes on
   *   And the log holds the failure and the denial
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A hook that throws denies, and is logged', async () => {
    const ran: string[] = [];
    const log = join(mkdtempSync(join(tmpdir(), 'yaah-hooks-')), 'yaah.log');
    running = await startHarness({
      config: `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      tools: [recording('wire_money', ran)],
      setup: (ctx) => {
        ctx.hooks.register('tool.before', {
          run: () => {
            throw new Error('policy database unreachable');
          },
        });
      },
      turns: [callTools(call('c1', 'wire_money')), say('I could not do that.')],
    });
    const turn = await running.send('Wire 5.');
    expect(ran).toEqual([]);
    const [result] = toolResults(running.llm.requests[1]);
    expect(result?.ok === false ? result.error.message : '').toContain(
      'a hook failed: policy database unreachable',
    );
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const lines = readFileSync(log, 'utf8').split('\n');
    expect(lines.some((line) => line.includes('"event":"hooks/failed"'))).toBe(true);
    const denied = lines.find((line) => line.includes('"event":"hooks/denied"')) ?? '';
    expect(denied).toContain('"hook":"tool.before"');
    expect(denied).toContain('"subject":"wire_money"');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: Every lifecycle point reaches its hooks, in order
   *   Given a hook on each lifecycle point
   *   When a turn runs in which the model calls one tool and then answers
   *   Then the hooks ran in the order the turn met the points, each with the task's id
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('Every lifecycle point reaches its hooks, in order', async () => {
    const seen: string[] = [];
    const tasks = new Set<string | null>();
    running = await startHarness({
      tools: [recording('read_balance', [])],
      setup: (ctx) => {
        const { hooks } = ctx;
        hooks.register('message.received', {
          run: (event) => void seen.push(`message.received ${event.text} ${String(event.taskId)}`),
        });
        hooks.register('llm.before', { run: (event) => void tasks.add(event.taskId) });
        hooks.register('llm.before', { run: () => void seen.push('llm.before') });
        hooks.register('llm.after', {
          run: (event) => void seen.push(`llm.after [${event.toolCalls.join(',')}]`),
        });
        hooks.register('tool.before', {
          run: (event) => void seen.push(`tool.before ${event.tool}`),
        });
        hooks.register('tool.after', {
          run: (event) => void seen.push(`tool.after ${event.tool} ${String(event.ok)}`),
        });
        hooks.register('task.transition', {
          run: (event) => {
            tasks.add(event.taskId);
            seen.push(`task.transition ${event.reason} ${event.state}`);
          },
        });
      },
      turns: [callTools(call('c1', 'read_balance')), say('You have 12.')],
    });
    const turn = await running.send('balance?');
    expect(seen).toEqual([
      'message.received balance? null',
      'task.transition turn-start working',
      'llm.before',
      'llm.after [read_balance]',
      'tool.before read_balance',
      'tool.after read_balance true',
      'llm.before',
      'llm.after []',
      'task.transition turn-complete completed',
    ]);
    expect([...tasks]).toEqual([turn.task?.id ?? '']);
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A hook refuses a message
   *   Given a message.received hook that denies messages mentioning a competitor
   *   When such a message is sent
   *   Then the sender is answered with the reason, no task is created and no model is called
   *   And another message is delivered as usual
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A hook refuses a message', async () => {
    const discarded: string[] = [];
    running = await startHarness({
      setup: (ctx) => {
        ctx.on('inbox/discarded', (_taskId, reason) => void discarded.push(reason));
        ctx.hooks.register('message.received', {
          run: (event) =>
            event.text.includes('Initech')
              ? { decision: 'deny', reason: 'competitors are off limits' }
              : undefined,
        });
      },
      turns: [say('Hello!')],
    });
    const refused = await running.send('Tell me about Initech.');
    expect(refused.task).toBeUndefined();
    const part = refused.reply?.parts[0]?.content;
    expect(part?.$case === 'text' ? part.value : '').toBe(
      'Your message was not accepted: competitors are off limits',
    );
    expect(running.llm.requests).toHaveLength(0);
    expect(discarded).toEqual(['competitors are off limits']);

    const accepted = await running.send('Hello.');
    expect(accepted.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const followUp = await running.send('And Initech?', {
      contextId: accepted.task?.contextId ?? '',
    });
    expect(followUp.task).toBeUndefined();
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A hook refuses a sub-agent
   *   Given an agent.before hook that denies the agent "billing"
   *   When the model calls invoke_agent for "billing" and for "shipping"
   *   Then the hook was asked about both, by agent id
   *   And the "billing" invocation is not made and the model is told why
   *   And the "shipping" invocation is let through to the tool
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A hook refuses a sub-agent', async () => {
    const asked: string[] = [];
    running = await startHarness({
      setup: (ctx) => {
        ctx.hooks.register('agent.before', {
          match: '*',
          run: (event) => {
            asked.push(event.agent);
            return event.agent === 'billing'
              ? { decision: 'deny', reason: 'billing is frozen' }
              : { decision: 'allow' };
          },
        });
      },
      turns: [
        callTools(
          call('c1', 'invoke_agent', { agent: 'billing', message: 'refund' }),
          call('c2', 'invoke_agent', { agent: 'shipping', message: 'where?' }),
        ),
        say('Billing is unavailable.'),
      ],
    });
    await running.send('Ask billing and shipping.');
    expect(asked).toEqual(['billing', 'shipping']);
    const [billing, shipping] = toolResults(running.llm.requests[1]);
    expect(billing?.ok === false ? billing.error : {}).toEqual({
      code: 'denied',
      message: 'The call to invoke_agent was denied by a hook and did not run: billing is frozen',
    });
    // Let through: the tool itself then reports that no such agent is registered.
    expect(shipping?.ok === false ? shipping.error.code : '').toBe('not-found');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A hook refuses a sub-agent reached as a participant
   *   Given an agent.before hook that denies the agent "billing"
   *   And a task on which "billing" is a participant
   *   When the model calls message_participant and create_task_for_participant for "billing"
   *   Then the hook was asked about each call, by agent id
   *   And "billing" receives nothing and the model is told why
   * Requirement: docs/specs/issue-3/requirements.md R9.3, R12.2 (self-review 1,
   *   extensions #1)
   */
  test('A hook refuses a sub-agent reached as a participant', async () => {
    const asked: string[] = [];
    const billing = fakeAgent('billing', () => 'refunded');
    running = await startHarness({
      setup: (ctx) => {
        registerEntity(ctx, billing.agent);
        ctx.hooks.register('agent.before', {
          match: 'billing',
          run: (event) => {
            asked.push(event.agent);
            return { decision: 'deny', reason: 'billing is frozen' };
          },
        });
      },
      turns: [
        callTools(
          call('c1', 'message_participant', { to: 'billing', message: 'refund?' }),
          call('c2', 'create_task_for_participant', { to: 'billing', message: 'refund' }),
        ),
        say('Billing is unavailable.'),
      ],
    });
    const participants = [
      { id: 'ada', role: 'reporter', kind: 'user' },
      { id: 'self', role: 'assignee', kind: 'agent' },
      { id: 'billing', role: 'watcher', kind: 'agent' },
    ];
    await running.send('Ask billing.', {
      metadata: { [EXT.taskModel]: { participants } },
      extensions: [EXT.taskModel],
    });
    expect(asked).toEqual(['billing', 'billing']);
    expect(billing.received).toEqual([]);
    const results = toolResults(running.llm.requests[1]);
    expect(results.map((result) => (result.ok ? '' : result.error.code))).toEqual([
      'denied',
      'denied',
    ]);
    expect(results[0]?.ok === false ? results[0].error.message : '').toBe(
      'The call to message_participant was denied by a hook and did not run: billing is frozen',
    );
  });
});
