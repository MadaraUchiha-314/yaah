import { afterEach, describe, expect, test } from 'bun:test';

import { attach } from '../../src/surface/attach.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { EMPTY_VIEW } from '../../src/surface/view.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    stop();
  }
  await running?.stop();
  running = undefined;
});

/** A surface reduced to what matters here: a view, a busy flag, a session. */
class Surface {
  view: TaskView = EMPTY_VIEW;
  busy = false;
  readonly session: HarnessSession;

  constructor(session: HarnessSession, adopt: boolean) {
    this.session = session;
    stops.push(
      attach(session, {
        adopt,
        idleMs: 20,
        current: () => this.view,
        busy: () => this.busy,
        show: (view) => {
          this.view = view;
        },
      }),
    );
  }

  async send(text: string): Promise<void> {
    this.busy = true;
    for await (const view of this.session.send({ text }, this.view)) {
      this.view = view;
    }
    this.busy = false;
  }
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

const texts = (view: TaskView): string =>
  view.items.map((item) => ('text' in item ? item.text : item.name)).join(' | ');

describe('two surfaces on one task', () => {
  /**
   * Feature: Surfaces and renderers
   * Scenario: A second surface takes up an open task and both stay in step
   *   Given a surface that started a long-running task on which the agent asked a question
   *   When a second surface attaches to the harness, asking to take up the open task
   *   Then it shows that task with the question
   *   When the second surface answers
   *   Then the first surface, which sent nothing, shows the answer and the agent's reply
   *   And when the first surface completes the task, the second shows it completed
   * Requirement: docs/specs/issue-3/requirements.md R19.1, R19.3, R27.1, R27.4
   */
  test('A second surface takes up an open task and both stay in step', async () => {
    running = await startHarness({
      turns: [
        callTools(call('q1', 'ask_user', { question: 'Refund or store credit?' })),
        say('A refund it is.'),
      ],
    });
    const web = new Surface(
      await HarnessSession.connect(running.url, { longRunning: true }),
      false,
    );
    await web.send('My lamp arrived broken.');
    expect(web.view.state).toBe('awaiting-user-input');

    const terminal = new Surface(await HarnessSession.connect(running.url), true);
    // The task is adopted from the listing first, then its history arrives with the follow.
    await until(() => texts(terminal.view).includes('Refund or store credit?'));
    expect(terminal.view.taskId).toBe(web.view.taskId);
    expect(terminal.view.state).toBe('awaiting-user-input');
    expect(texts(terminal.view)).toContain('Refund or store credit?');

    await terminal.send('A refund, please.');
    expect(texts(terminal.view)).toContain('A refund it is.');
    await until(() => texts(web.view).includes('A refund it is.'));
    expect(texts(web.view)).toContain('A refund, please.');
    expect(texts(web.view)).toContain('A refund it is.');

    web.busy = true;
    web.view = await web.session.complete(web.view);
    web.busy = false;
    await until(() => terminal.view.state === 'completed');
    expect(terminal.view.state).toBe('completed');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: News from another surface is added to what a surface shows
   *   Given a terminal that asked a question, was answered, and ran two commands
   *   When another surface sends a message on the same task and is answered
   *   Then the terminal shows that message and its answer after what it showed before
   *   And its own answer keeps the id it was first shown under, and the commands' replies stay
   * Requirement: docs/specs/issue-3/requirements.md R19.1, R27.4
   */
  test('News from another surface is added to what a surface shows', async () => {
    running = await startHarness({ turns: [say('Hello.'), say('Bye.')] });
    const terminal = new Surface(
      await HarnessSession.connect(running.url, { longRunning: true }),
      false,
    );
    await terminal.send('hi');
    await terminal.send('/effort high');
    await terminal.send('/effort low');
    const before = terminal.view.items;
    const answer = before.find((item) => item.kind === 'agent');
    expect(answer?.id.startsWith('response-')).toBe(true);
    expect(before.filter((item) => item.kind === 'note')).toHaveLength(2);

    const web = new Surface(await HarnessSession.connect(running.url), false);
    web.view = { ...terminal.view, items: [] };
    await web.send('thanks');
    await until(() => texts(terminal.view).includes('Bye.'));
    expect(terminal.view.items.slice(0, before.length)).toEqual([...before]);
    expect(texts(terminal.view).endsWith('thanks | Bye.')).toBe(true);
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A surface does not take up another's task unless asked to
   *   Given an open task on the harness
   *   When a surface attaches without asking to take it up
   *   Then it stays empty, ready to start a task of its own
   * Requirement: docs/specs/issue-3/requirements.md R19.3
   */
  test("A surface does not take up another's task unless asked to", async () => {
    running = await startHarness({ turns: [say('Hello.')] });
    const first = new Surface(
      await HarnessSession.connect(running.url, { longRunning: true }),
      false,
    );
    await first.send('hi');
    const second = new Surface(await HarnessSession.connect(running.url), false);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(second.view).toBe(EMPTY_VIEW);
  });
});
