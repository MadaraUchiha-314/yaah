/**
 * The inbox: the one way anything reaches a task. An item is stored before the call that
 * brought it is acknowledged, and only then is the task's run told about it — so nothing
 * accepted is ever lost, whatever happens next.
 */
import type { InboxStore } from '../../harness/core/persistence.ts';
import type { InboxItemRef } from '../../harness/core/step-runner.ts';
import type { InboxItem } from '../../harness/core/types.ts';
import type { DurableExecution } from '../durable/types.ts';

function refOf(item: InboxItem): InboxItemRef {
  return { id: item.id, kind: item.payload.kind, interrupt: item.interrupt };
}

/** Accepts items for tasks. */
export class Inbox {
  readonly #store: InboxStore;
  readonly #durable: DurableExecution;

  constructor(store: InboxStore, durable: DurableExecution) {
    this.#store = store;
    this.#durable = durable;
  }

  /**
   * Stores `item` and hands it to its task's run.
   *
   * Delivering an item twice — a client retry, a redelivery after a restart — stores it
   * once and consumes it once.
   */
  async accept(item: InboxItem): Promise<'stored' | 'duplicate'> {
    const outcome = await this.#store.put(item);
    await this.#durable.deliver(item.taskId, refOf(item));
    return outcome;
  }

  /**
   * Hands stored, unconsumed items to their tasks' runs again — all of them after a
   * restart, or only those received before `before` when the heartbeat looks for items
   * a run never took. A run that already holds an item ignores the second delivery.
   */
  async redeliverPending(before?: Date): Promise<number> {
    const stored = await this.#store.pending();
    const pending =
      before === undefined
        ? stored
        : stored.filter((item: InboxItem) => new Date(item.receivedAt) < before);
    await Promise.all(
      pending.map((item: InboxItem) => this.#durable.deliver(item.taskId, refOf(item))),
    );
    return pending.length;
  }
}
