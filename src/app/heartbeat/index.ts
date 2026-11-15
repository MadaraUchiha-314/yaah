/**
 * The heartbeat plugin: the harness waking on its own. Every interval it hands inbox
 * items no run has taken back to their tasks, and reports each working task that has
 * made no progress for too long.
 *
 * It decides nothing about a stalled task: it emits `task/stalled`, and what listens —
 * the log, an operator's plugin — acts.
 */
import { TaskState } from '@a2a-js/sdk';
import type { Context } from 'cordis';

import type { StepCall } from '../../harness/core/step-middleware.ts';

declare module 'cordis' {
  interface Events {
    /** The heartbeat fired. `redelivered` inbox items were handed to their runs again. */
    'heartbeat/tick'(at: Date, redelivered: number): void;
    /** A heartbeat could not complete; the next one runs as usual. */
    'heartbeat/failed'(error: unknown): void;
    /**
     * A working task has made no progress for `idleMs`. Emitted once per stall: again
     * only after the task has taken another step.
     */
    'task/stalled'(taskId: string, idleMs: number): void;
  }
}

/** Options of the plugin. Tests pass a clock; the composition passes nothing. */
export interface HeartbeatOptions {
  readonly now?: (() => Date) | undefined;
}

/**
 * Lets the process end while `timer` is pending. In a browser a timer is a number and
 * there is no process to keep alive.
 */
function detach(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object') {
    timer.unref();
  }
}

export const name = 'heartbeat';
export const inject: readonly string[] = ['config', 'taskRuntime', 'a2a'];

/** What one heartbeat does. Exposed so a test can beat without waiting for the timer. */
export interface Heartbeat {
  /** Runs one heartbeat now. */
  beat(): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    /** The harness's heartbeat. */
    heartbeat: Heartbeat;
  }
}

/** Starts the heartbeat. */
export function apply(ctx: Context, options: HeartbeatOptions = {}): void {
  const { intervalMs, stalledAfterMs } = ctx.config.heartbeat;
  const now = options.now ?? ((): Date => new Date());
  /** When each task last started or finished a step. */
  const progress = new Map<string, number>();
  /** Tasks already reported for their current stall. */
  const reported = new Set<string>();
  const touch = (taskId: string): void => {
    progress.set(taskId, now().getTime());
    reported.delete(taskId);
  };

  const stalled = (): void => {
    const working = ctx.taskRuntime.taskStore
      .open()
      .filter((task) => task.status?.state === TaskState.TASK_STATE_WORKING);
    const ids = new Set(working.map((task) => task.id));
    for (const taskId of progress.keys()) {
      if (!ids.has(taskId)) {
        progress.delete(taskId);
        reported.delete(taskId);
      }
    }
    for (const task of working) {
      // A task this process has not seen step (it was working before a restart) is
      // measured from the time of its last recorded status.
      const since = progress.get(task.id) ?? Date.parse(task.status?.timestamp ?? '');
      const idleMs = now().getTime() - since;
      if (idleMs >= stalledAfterMs && !reported.has(task.id)) {
        reported.add(task.id);
        ctx.emit('task/stalled', task.id, idleMs);
      }
    }
  };

  const beat = async (): Promise<void> => {
    const at = now();
    // An item younger than one interval is still on its way to its run.
    const redelivered = await ctx.a2a.inbox.redeliverPending(new Date(at.getTime() - intervalMs));
    stalled();
    ctx.emit('heartbeat/tick', at, redelivered);
  };

  ctx.effect(() => {
    const removeMiddleware = ctx.taskRuntime.addStepMiddleware(
      async <T>(call: StepCall, next: () => Promise<T>): Promise<T> => {
        touch(call.taskId);
        try {
          return await next();
        } finally {
          touch(call.taskId);
        }
      },
    );
    const release = ctx.provide('heartbeat', { beat });
    const timer = setInterval(() => {
      beat().catch((error: unknown) => {
        ctx.emit('heartbeat/failed', error);
      });
    }, intervalMs);
    // The heartbeat never keeps the process alive on its own.
    detach(timer);
    return (): void => {
      clearInterval(timer);
      release();
      removeMiddleware();
    };
  });
}
