import { afterEach, describe, expect, test } from 'bun:test';

import { BASIC_CATALOG_ID } from '../../src/harness/a2ui/index.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { EMPTY_VIEW } from '../../src/surface/view.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function last(views: AsyncIterable<TaskView>): Promise<{ final: TaskView; all: TaskView[] }> {
  const all: TaskView[] = [];
  for await (const view of views) {
    all.push(view);
  }
  const final = all.at(-1);
  if (final === undefined) {
    throw new Error('no view was produced');
  }
  return { final, all };
}

const shape = (view: TaskView): string[] =>
  view.items.map((item) => `${item.kind}:${'text' in item ? item.text : item.name}`);

const lookup = defineTool({
  id: 'lookup',
  description: 'Look an order up.',
  inputSchema: { type: 'object' },
  retrySafe: true,
  invoke: () => Promise.resolve(textResult('order found')),
});

describe('harness session', () => {
  /**
   * Feature: Surfaces and renderers
   * Scenario: A surface sees a turn as a growing transcript
   *   Given a surface connected to a harness through the session
   *   When the user sends a message that makes the agent call a tool and then answer
   *   Then the views show the user message at once, the tool starting and finishing,
   *        the answer streaming and then settled, and the task waiting for the next message
   * Requirement: docs/specs/issue-3/requirements.md R19.1, R19.2, R20.2, R20.3
   */
  test('A surface sees a turn as a growing transcript', async () => {
    running = await startHarness({
      tools: [lookup],
      turns: [callTools(call('c1', 'lookup')), say('Your order is on its way.')],
    });
    const session = await HarnessSession.connect(running.url);
    const { final, all } = await last(session.send({ text: 'Where is my order?' }));
    expect(shape(all[0] ?? EMPTY_VIEW)).toEqual(['user:Where is my order?']);
    expect(all[0]?.state).toBe('working');
    expect(shape(final)).toEqual([
      'user:Where is my order?',
      'tool:lookup',
      'agent:Your order is on its way.',
    ]);
    const tool = final.items.find((item) => item.kind === 'tool');
    expect(tool?.kind === 'tool' ? [tool.done, tool.ok] : []).toEqual([true, true]);
    expect(
      all.some((view) => view.items.some((item) => item.kind === 'agent' && item.streaming)),
    ).toBe(true);
    expect(final.items.every((item) => item.kind !== 'agent' || !item.streaming)).toBe(true);
    expect(final.state).toBe('awaiting-next-interaction');
    expect(final.taskId).not.toBeNull();
  });

  /**
   * Feature: Task lifecycle
   * Scenario: A surface continues, is asked for input, completes and cancels
   *   Given a surface with an open task
   *   When the agent asks a question, the user answers, and the user completes the task
   *   Then the views show the question as a request for input and the task as completed
   *   And a second task can be cancelled
   * Requirement: docs/specs/issue-3/requirements.md R14.3, R14.5, R14.6, R20.4
   */
  test('A surface continues, is asked for input, completes and cancels', async () => {
    running = await startHarness({
      turns: [
        callTools(call('c1', 'ask_user', { question: 'Refund or credit?' })),
        say('Refund filed.'),
        say('Second task.'),
      ],
    });
    const session = await HarnessSession.connect(running.url);
    const asked = (await last(session.send({ text: 'Help' }))).final;
    expect(asked.state).toBe('awaiting-user-input');
    expect(shape(asked)).toEqual(['user:Help', 'ask:Refund or credit?']);

    const answered = (await last(session.send({ text: 'Refund' }, asked))).final;
    expect(shape(answered)).toEqual([
      'user:Help',
      'ask:Refund or credit?',
      'user:Refund',
      'agent:Refund filed.',
    ]);
    expect(answered.taskId).toBe(asked.taskId);

    const completed = await session.complete(answered);
    expect(completed.state).toBe('completed');
    expect(running.llm.requests.length).toBe(2);

    const second = (await last(session.send({ text: 'Another' }, completed))).final;
    expect(second.taskId).not.toBe(asked.taskId);
    expect((await session.cancel(second)).state).toBe('canceled');
  });

  /**
   * Feature: Commands
   * Scenario: A surface knows the commands and shows a command's reply as a note
   *   Given a surface connected to a harness
   *   When it reads the session and sends /model
   *   Then the commands are listed for highlighting, and the reply is a note, not a task
   * Requirement: docs/specs/issue-3/requirements.md R20.5, R23.1
   */
  test("A surface knows the commands and shows a command's reply as a note", async () => {
    running = await startHarness({});
    const session = await HarnessSession.connect(running.url);
    expect(session.commands.map((command) => command.name).toSorted()).toEqual([
      'effort',
      'exit',
      'model',
    ]);
    expect(session.dashboardUrl).toBeNull();
    const { final } = await last(session.send({ text: '/model' }));
    expect(final.taskId).toBeNull();
    expect(final.items.at(-1)?.kind).toBe('note');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: Two surfaces follow one task
   *   Given a task opened from one surface
   *   When a second surface finds it and follows it, and the first surface sends another turn
   *   Then the second surface shows the first turn at once and the second turn as it happens
   * Requirement: docs/specs/issue-3/requirements.md R19.3
   */
  test('Two surfaces follow one task', async () => {
    running = await startHarness({
      turns: [say('First answer.'), say('Second answer.')],
      llmDelayMs: 5,
    });
    const first = await HarnessSession.connect(running.url);
    const opened = (await last(first.send({ text: 'One' }))).final;

    const second = await HarnessSession.connect(running.url);
    const [joinable] = await second.openTasks(opened.contextId ?? '');
    expect(joinable?.id).toBe(opened.taskId ?? '');
    const stop = new AbortController();
    const seen: TaskView[] = [];
    const following = (async () => {
      for await (const view of second.follow(joinable?.id ?? '', stop.signal)) {
        seen.push(view);
        if (
          view.items.some(
            (item) => item.kind === 'agent' && item.text === 'Second answer.' && !item.streaming,
          )
        ) {
          stop.abort();
        }
      }
    })();
    while (seen.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the follower's snapshot
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    expect(shape(seen[0] ?? EMPTY_VIEW)).toEqual(['user:One', 'agent:First answer.']);

    await last(first.send({ text: 'Two' }, opened));
    await following;
    const final = seen.at(-1) ?? EMPTY_VIEW;
    expect(shape(final).filter((entry) => entry.startsWith('agent:'))).toEqual([
      'agent:First answer.',
      'agent:Second answer.',
    ]);
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A surface that renders A2UI receives the surface and returns an action
   *   Given a session that offers the basic catalog
   *   When the agent answers with an A2UI block and the user acts on it
   *   Then the answer's view carries the A2UI messages, and the action reaches the model
   * Requirement: docs/specs/issue-3/requirements.md R19.4
   */
  test('A surface that renders A2UI receives the surface and returns an action', async () => {
    running = await startHarness({
      turns: [
        say('A form:\n<a2ui>\nroot = Button(Text("Go"), action=Event("go"))\n</a2ui>'),
        say('Done.'),
      ],
    });
    const session = await HarnessSession.connect(running.url, { a2uiCatalogs: [BASIC_CATALOG_ID] });
    const shown = (await last(session.send({ text: 'Show me' }))).final;
    const answer = shown.items.find((item) => item.kind === 'agent');
    expect(answer?.kind === 'agent' ? JSON.stringify(answer.a2ui) : '').toContain('createSurface');
    const action = {
      version: '1.0',
      action: { name: 'go', surfaceId: 'main', sourceComponentId: 'root', context: {} },
    };
    const after = (await last(session.send({ text: '', a2uiAction: action }, shown))).final;
    expect(JSON.stringify(running.llm.requests[1]?.messages)).toContain('"go"');
    expect(after.items.at(-1)).toMatchObject({ kind: 'agent', text: 'Done.' });
  });
});
