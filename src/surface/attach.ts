/**
 * Keeps a surface in step with a task that other surfaces work on too: at start it can
 * adopt the task that is already open on the harness, and from then on it shows what
 * happens on the surface's current task while the surface itself is not in a turn.
 *
 * It only ever shows news — a different task, a new state, more items — and adds it to
 * what the surface shows rather than replacing it, so a form the user is filling in is
 * not redrawn under their hands.
 */
import type { Task } from '@a2a-js/sdk';

import type { TaskView } from './view.ts';
import { isOpen, mergeView, viewOfTask } from './view.ts';

/** The part of `HarnessSession` this needs. */
export interface Followable {
  openTasks(): Promise<Task[]>;
  follow(taskId: string, signal: AbortSignal): AsyncIterable<TaskView>;
}

/** How the attachment reads and updates the surface. */
export interface AttachHooks {
  /** The view on screen now. */
  readonly current: () => TaskView;
  /** True while the surface's own turn is in flight; its stream owns the view then. */
  readonly busy: () => boolean;
  readonly show: (view: TaskView) => void;
  /**
   * Whether to adopt a task that is already open on the harness when the surface has
   * none. Off, the surface only follows tasks it started or was given.
   */
  readonly adopt?: boolean | undefined;
  /** How long to wait before looking again when there is nothing to follow. */
  readonly idleMs?: number | undefined;
}

const IDLE_MS = 500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Whether `next` tells the user something `shown` does not. */
export function isNews(next: TaskView, shown: TaskView): boolean {
  return (
    next.taskId !== shown.taskId ||
    next.state !== shown.state ||
    next.items.length > shown.items.length
  );
}

/** The open task whose status changed last, if any. */
export function latestOpen(tasks: readonly Task[]): Task | undefined {
  return tasks.toSorted((a: Task, b: Task) =>
    (b.status?.timestamp ?? '').localeCompare(a.status?.timestamp ?? ''),
  )[0];
}

async function followOne(
  session: Followable,
  taskId: string,
  hooks: AttachHooks,
  signal: AbortSignal,
): Promise<void> {
  for await (const learned of session.follow(taskId, signal)) {
    const shown = hooks.current();
    if (shown.taskId !== null && shown.taskId !== taskId) {
      // The user has moved on to another task.
      return;
    }
    // What the follower learned is added to what is shown; notes, tool lines and the ids
    // things were shown under stay.
    const view = shown.taskId === null ? learned : mergeView(shown, learned);
    if (!hooks.busy() && isNews(view, shown)) {
      hooks.show(view);
    }
  }
}

async function run(session: Followable, hooks: AttachHooks, signal: AbortSignal): Promise<void> {
  const idleMs = hooks.idleMs ?? IDLE_MS;
  if (hooks.adopt === true && hooks.current().taskId === null) {
    const open = latestOpen(await session.openTasks());
    if (open !== undefined && hooks.current().taskId === null && !hooks.busy()) {
      hooks.show(viewOfTask(open));
    }
  }
  while (!signal.aborted) {
    const shown = hooks.current();
    if (shown.taskId !== null && isOpen(shown)) {
      // oxlint-disable-next-line no-await-in-loop -- one task is followed at a time
      await followOne(session, shown.taskId, hooks, signal);
    }
    // oxlint-disable-next-line no-await-in-loop -- waiting for a task to follow
    await sleep(idleMs, signal);
  }
}

/**
 * Starts following. Returns the function that stops it. A failure to reach the harness
 * ends the attachment quietly: the surface still works for its own turns.
 */
export function attach(session: Followable, hooks: AttachHooks): () => void {
  const stop = new AbortController();
  run(session, hooks, stop.signal).catch(() => undefined);
  return (): void => {
    stop.abort();
  };
}
