import { afterEach, describe, expect, test } from 'bun:test';

import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function last(views: AsyncIterable<TaskView>): Promise<TaskView | Error> {
  let final: TaskView | undefined = undefined;
  try {
    for await (const view of views) {
      final = view;
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return final ?? new Error('no view');
}

/** Scenarios that came out of the exploratory session (testing plan, T11). */
describe('exploratory findings', () => {
  /**
   * Feature: A2A API server
   * Scenario: A message that says nothing is refused before any model call
   *   Given a running harness
   *   When a client sends a message with no text, or only white space
   *   Then the call fails with a reason, no task is created and the model is not called
   *   And a message whose only content is a lifecycle action is still accepted
   * Requirement: docs/specs/issue-3/requirements.md R13.1; Security considerations,
   *   abuse case 8
   */
  test('A message that says nothing is refused before any model call', async () => {
    running = await startHarness({ turns: [say('Hello.')] });
    const session = await HarnessSession.connect(running.url, { longRunning: true });
    for (const text of ['', '   \n\t']) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      const outcome = await last(session.send({ text }));
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome instanceof Error ? outcome.message : '').toContain('The message is empty');
    }
    expect(running.llm.requests).toHaveLength(0);
    expect(await session.openTasks()).toEqual([]);

    const first = await last(session.send({ text: 'hi' }));
    expect(first).not.toBeInstanceOf(Error);
    const done = first instanceof Error ? first : await session.complete(first);
    expect(done instanceof Error ? '' : done.state).toBe('completed');
  });

  /**
   * Feature: Commands
   * Scenario: After a command's reply the view is in the state it was in before
   *   Given a surface with no task, and then with a task waiting for the next message
   *   When the user sends a command
   *   Then the last view shows the reply as a note and the state from before the command,
   *        not "working"
   * Requirement: docs/specs/issue-3/requirements.md R23.1, R20.2
   */
  test("After a command's reply the view is in the state it was in before", async () => {
    running = await startHarness({ turns: [say('Hello.')] });
    const session = await HarnessSession.connect(running.url, { longRunning: true });
    const fresh = await last(session.send({ text: '/effort' }));
    expect(fresh instanceof Error ? '' : fresh.state).toBe('idle');
    expect(JSON.stringify(fresh)).toContain('Effort:');

    const waiting = await last(session.send({ text: 'hi' }));
    const after =
      waiting instanceof Error ? waiting : await last(session.send({ text: '/model' }, waiting));
    expect(after instanceof Error ? '' : after.state).toBe('awaiting-next-interaction');
    expect(running.llm.requests).toHaveLength(1);
  });
});
