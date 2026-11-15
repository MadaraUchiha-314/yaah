import type { Task } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import type { Followable } from './attach.ts';
import { attach, isNews, latestOpen } from './attach.ts';
import type { TaskView } from './view.ts';
import { EMPTY_VIEW } from './view.ts';

function task(id: string, timestamp: string): Task {
  return {
    id,
    contextId: `ctx-${id}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

const view = (taskId: string, items: number, state: TaskView['state'] = 'working'): TaskView => ({
  ...EMPTY_VIEW,
  taskId,
  state,
  items: Array.from({ length: items }, (_unused, index) => ({
    kind: 'note',
    id: `n${String(index)}`,
    text: 'x',
  })),
});

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
}

describe('attach', () => {
  test('news is another task, another state or more items — nothing else', () => {
    expect(isNews(view('t1', 1), view('t1', 1))).toBe(false);
    expect(isNews(view('t1', 2), view('t1', 1))).toBe(true);
    expect(isNews(view('t1', 1, 'completed'), view('t1', 1))).toBe(true);
    expect(isNews(view('t2', 1), view('t1', 1))).toBe(true);
    expect(isNews(view('t1', 0), view('t1', 1))).toBe(false);
  });

  test('the open task whose status changed last is the one adopted', () => {
    const tasks = [task('old', '2026-01-01T00:00:00Z'), task('new', '2026-01-02T00:00:00Z')];
    expect(latestOpen(tasks)?.id).toBe('new');
    expect(latestOpen([])).toBeUndefined();
  });

  test('adopts the open task, shows only news, and leaves a busy surface alone', async () => {
    let shown: TaskView = EMPTY_VIEW;
    let busy = false;
    const followed: string[] = [];
    const feed: TaskView[] = [view('t1', 1), view('t1', 1), view('t1', 2), view('t1', 3)];
    const session: Followable = {
      openTasks: () => Promise.resolve([task('t1', '2026-01-01T00:00:00Z')]),
      async *follow(taskId: string) {
        followed.push(taskId);
        for (const next of feed.splice(0)) {
          busy = next.items.length === 3;
          yield next;
          // oxlint-disable-next-line no-await-in-loop -- one view at a time
          await Promise.resolve();
        }
      },
    };
    const seen: number[] = [];
    const stop = attach(session, {
      current: () => shown,
      busy: () => busy,
      adopt: true,
      idleMs: 5,
      show: (next) => {
        shown = next;
        seen.push(next.items.length);
      },
    });
    await settle();
    stop();
    // Adopted (0 items), then 1 and 2; the unchanged view and the one that arrived while
    // the surface was busy were not shown.
    expect(seen).toEqual([0, 1, 2]);
    expect(followed[0]).toBe('t1');
  });

  test('with nothing open it waits for the surface to start a task, then follows it', async () => {
    let shown: TaskView = EMPTY_VIEW;
    const followed: string[] = [];
    const session: Followable = {
      openTasks: () => Promise.resolve([]),
      // oxlint-disable-next-line require-yield -- a task with nothing to report
      async *follow(taskId: string) {
        followed.push(taskId);
        await Promise.resolve();
      },
    };
    const stop = attach(session, {
      current: () => shown,
      busy: () => false,
      idleMs: 5,
      show: (next) => {
        shown = next;
      },
    });
    await settle();
    expect(followed).toEqual([]);
    shown = view('mine', 1);
    await settle();
    stop();
    expect(followed[0]).toBe('mine');
    const calls = followed.length;
    await settle();
    expect(followed).toHaveLength(calls);
  });

  test('a harness that cannot be reached ends the attachment quietly', async () => {
    const session: Followable = {
      openTasks: () => Promise.reject(new Error('down')),
      // oxlint-disable-next-line require-yield -- never reached
      async *follow() {
        await Promise.resolve();
      },
    };
    const stop = attach(session, {
      current: () => EMPTY_VIEW,
      busy: () => false,
      show: () => undefined,
    });
    await settle();
    stop();
    expect(true).toBe(true);
  });
});
