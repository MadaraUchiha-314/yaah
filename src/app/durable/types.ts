/**
 * Durable execution: who runs a task's loop, and what survives a crash. One interface,
 * three implementations — in-process (mode `none`), embedded Temporal, remote Temporal —
 * so that a client sees the same A2A behaviour whichever is configured.
 */
import type { InboxItemRef } from '../../harness/core/step-runner.ts';
import type { TaskId } from '../../harness/core/types.ts';
import type { DurableMode } from '../../kernel/config-types.ts';

/** Runs task loops. */
export interface DurableExecution {
  readonly mode: DurableMode;
  /**
   * Hands an accepted inbox item to the task's run, starting the run if the task has
   * none. The item is already stored; this call makes the run aware of it.
   */
  deliver(taskId: TaskId, item: InboxItemRef): Promise<void>;
  /** Cancels the task's run. The loop records the `canceled` status. */
  cancel(taskId: TaskId): Promise<void>;
  /** Picks every open task up again after a restart. */
  recover(taskIds: readonly TaskId[]): Promise<void>;
  /** The Temporal Web UI of this harness, or null in mode `none`. */
  dashboard(): { readonly url: string } | null;
  /** The task's workflow in the Temporal Web UI, or null in mode `none`. */
  taskUrl(taskId: TaskId): string | null;
  /** Stops every run where it is, recording nothing; they resume at the next start. */
  close(): Promise<void>;
}
