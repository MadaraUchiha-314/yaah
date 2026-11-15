import type { Task } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import type { ChatSession } from '../../../../test/web/index.ts';
import { ChatScreen, render, waitFor, webTest } from '../../../../test/web/index.ts';
import type { TaskView } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';

webTest();

const OPEN: Task = {
  id: 't-open',
  contextId: 'c1',
  status: {
    state: TaskState.TASK_STATE_INPUT_REQUIRED,
    message: undefined,
    timestamp: '2026-01-01T00:00:00Z',
  },
  artifacts: [],
  history: [],
  metadata: undefined,
};

/** A session with one task open on the harness, on which another surface then speaks. */
function session(adopt: boolean): ChatSession & { readonly followed: string[] } {
  const followed: string[] = [];
  return {
    followed,
    adopt,
    commands: [],
    dashboardUrl: null,
    // oxlint-disable-next-line require-yield -- this surface sends nothing in these tests
    async *send(): AsyncIterable<TaskView> {
      await Promise.resolve();
    },
    complete: (view: TaskView): Promise<TaskView> => Promise.resolve(view),
    cancel: (view: TaskView): Promise<TaskView> => Promise.resolve(view),
    openTasks: (): Promise<Task[]> => Promise.resolve([OPEN]),
    async *follow(taskId: string): AsyncIterable<TaskView> {
      followed.push(taskId);
      await Promise.resolve();
      yield {
        ...EMPTY_VIEW,
        taskId,
        state: 'awaiting-user-input',
        items: [{ kind: 'ask', id: 'q1', text: 'Refund or store credit?' }],
      };
    },
  };
}

describe('the chat and a task open on the harness', () => {
  /**
   * Feature: Web renderer
   * Scenario: Opened with ?attach, the chat takes up the open task
   *   Given a harness with a task on which the agent is waiting for an answer
   *   When the chat is opened asking to take that task up
   *   Then it follows the task and shows the question another surface was asked
   * Requirement: docs/specs/issue-3/requirements.md R19.3, R27.1
   */
  test('Opened with ?attach, the chat takes up the open task', async () => {
    const harness = session(true);
    const { container } = render(<ChatScreen session={harness} />);
    await waitFor(() => {
      expect(container.textContent).toContain('Refund or store credit?');
    });
    expect(harness.followed[0]).toBe('t-open');
  });

  test('opened plainly, the chat stays empty and follows nothing', async () => {
    const harness = session(false);
    const { container } = render(<ChatScreen session={harness} />);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(container.textContent).not.toContain('Refund or store credit?');
    expect(harness.followed).toEqual([]);
  });
});
