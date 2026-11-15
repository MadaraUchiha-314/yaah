/**
 * The inbox: the one way anything reaches a task. An item is stored before the call that
 * brought it is acknowledged, and only then is the task's run told about it — so nothing
 * accepted is ever lost, whatever happens next.
 */
import type { InboxStore } from '../../harness/core/persistence.ts';
import type { InboxItemRef } from '../../harness/core/step-runner.ts';
import type { InboxItem, TaskId } from '../../harness/core/types.ts';
import type { DurableExecution } from '../durable/types.ts';

function refOf(item: InboxItem): InboxItemRef {
  return { id: item.id, kind: item.payload.kind, interrupt: item.interrupt };
}

/** Accepts items for tasks. */
export class Inbox {
  readonly #store: InboxStore;
  readonly #durable: DurableExecution;
  readonly #isClosed: (taskId: TaskId) => boolean;

  /**
   * @param isClosed Whether a task has reached a terminal state. An item left behind for
   *   such a task is never handed to a run again: that would start the task anew.
   */
  constructor(
    store: InboxStore,
    durable: DurableExecution,
    isClosed: (taskId: TaskId) => boolean = (): boolean => false,
  ) {
    this.#store = store;
    this.#durable = durable;
    this.#isClosed = isClosed;
  }

  /**
   * Stores `item` and hands it to its task's run.
   *
   * Delivering an item twice — a client retry, a redelivery after a restart — stores it
   * once and consumes it once. An item the run has consumed already is not handed over
   * again, and the outcome is `consumed`: no run will act on it.
   */
  async accept(item: InboxItem): Promise<'stored' | 'duplicate' | 'consumed'> {
    const outcome = await this.#store.put(item);
    if (outcome === 'duplicate') {
      const pending = await this.#store.pending(item.taskId);
      if (!pending.some((stored: InboxItem) => stored.id === item.id)) {
        return 'consumed';
      }
    }
    await this.#durable.deliver(item.taskId, refOf(item));
    return outcome;
  }

  /**
   * Hands stored, unconsumed items to their tasks' runs again — all of them after a
   * restart, or only those received before `before` when the heartbeat looks for items
   * a run never took. A run that already holds an item ignores the second delivery.
   *
   * An item whose task has ended — it was queued when the task was cancelled or failed —
   * is retired instead: delivering it would start a run for a task that is over.
   */
  async redeliverPending(before?: Date): Promise<number> {
    const stored = await this.#store.pending();
    const stranded = stored.filter((item: InboxItem) => this.#isClosed(item.taskId));
    if (stranded.length > 0) {
      await this.#store.markProcessed(stranded.map((item: InboxItem) => item.id));
    }
    const open = stored.filter((item: InboxItem) => !stranded.includes(item));
    const pending =
      before === undefined
        ? open
        : open.filter((item: InboxItem) => new Date(item.receivedAt) < before);
    await Promise.all(
      pending.map((item: InboxItem) => this.#durable.deliver(item.taskId, refOf(item))),
    );
    return pending.length;
  }
}
