/**
 * Durable execution without Temporal (mode `none`): each task's loop runs in this
 * process on a journaled runner. A restart replays the journal, so a finished step is
 * never performed twice.
 */
import type { StepHandlers } from '../../harness/core/direct-runner.ts';
import { DirectRunner } from '../../harness/core/direct-runner.ts';
import { runTask } from '../../harness/core/loop.ts';
import type { StepJournal } from '../../harness/core/persistence.ts';
import type { InboxItemRef, RunLimits } from '../../harness/core/step-runner.ts';
import type { TaskId } from '../../harness/core/types.ts';
import type { DurableExecution } from './types.ts';

/** What the in-process mode works with. */
export interface InProcessDeps {
  readonly handlers: StepHandlers;
  readonly limits: RunLimits;
  readonly journal: StepJournal;
  /** Told when a run ends for a reason other than a shutdown. */
  readonly onError?: ((taskId: TaskId, error: unknown) => void) | undefined;
}

interface Run {
  readonly runner: DirectRunner;
  readonly finished: Promise<void>;
}

/** The in-process implementation of {@link DurableExecution}. */
export class InProcessDurable implements DurableExecution {
  readonly mode = 'none';
  readonly #deps: InProcessDeps;
  readonly #runs = new Map<TaskId, Run>();

  constructor(deps: InProcessDeps) {
    this.#deps = deps;
  }

  deliver(taskId: TaskId, item: InboxItemRef): Promise<void> {
    this.#run(taskId).runner.deliver(item);
    return Promise.resolve();
  }

  cancel(taskId: TaskId): Promise<void> {
    this.#run(taskId).runner.cancel();
    return Promise.resolve();
  }

  recover(taskIds: readonly TaskId[]): Promise<void> {
    for (const taskId of taskIds) {
      this.#run(taskId);
    }
    return Promise.resolve();
  }

  dashboard(): null {
    return null;
  }

  taskUrl(): null {
    return null;
  }

  async close(): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) {
      run.runner.abandon();
    }
    await Promise.all(runs.map((run: Run) => run.finished));
  }

  /** How many task loops are alive in this process. */
  get active(): number {
    return this.#runs.size;
  }

  /** The task's run, started (and replayed from the journal) if it has none. */
  #run(taskId: TaskId): Run {
    const existing = this.#runs.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const runner = new DirectRunner(taskId, this.#deps.handlers, this.#deps.limits, {
      journal: this.#deps.journal,
    });
    const finished = runTask(runner)
      .then(
        () => undefined,
        (error: unknown) => {
          if (!runner.abandoned) {
            this.#deps.onError?.(taskId, error);
          }
        },
      )
      .finally(() => {
        this.#runs.delete(taskId);
      });
    const run: Run = { runner, finished };
    this.#runs.set(taskId, run);
    return run;
  }
}
