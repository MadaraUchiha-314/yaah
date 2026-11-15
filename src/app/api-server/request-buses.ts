/**
 * Event buses for requests that overlap on one task.
 *
 * The SDK's default manager gives every request for a task the same bus. yaah lets a
 * second message arrive while a task is working, and each of those requests has a stream
 * that must begin with the task and then carry only updates: on a shared bus the second
 * request's opening `task` event is an ordering violation on the first one's stream, and
 * one request finishing closes the other's stream.
 *
 * So a task keeps one primary bus, handled exactly as the SDK's default manager handles
 * it (cancel and subscribe find it), and a request that arrives while the primary bus
 * has a request running gets a bus of its own for as long as it runs. The harness has
 * its own fan-out (the stream hub), so that request needs nothing from the primary bus.
 */
import type { ExecutionEventBus, ExecutionEventBusManager } from '@a2a-js/sdk/server';
import { DefaultExecutionEventBus } from '@a2a-js/sdk/server';

/** The buses made for one request alone. */
const OWN = new WeakSet<ExecutionEventBus>();

/**
 * Whether `bus` is a bus of a request's own. Nothing but that request listens on it, so
 * forwarding to it stops when the request's client goes away; the primary bus is also
 * what resubscribers listen on, so forwarding to it goes on until the task rests.
 */
export function isOwnBus(bus: ExecutionEventBus): boolean {
  return OWN.has(bus);
}

interface Primary {
  readonly bus: ExecutionEventBus;
  /** Whether a request is running on the bus right now. */
  busy: boolean;
}

/** The bus manager described above. */
export class RequestBusManager implements ExecutionEventBusManager {
  readonly #primary: Map<string, Primary>;

  constructor() {
    this.#primary = new Map();
  }

  /** The task's primary bus when no request is running on it; otherwise a bus of its own. */
  createOrGetByTaskId(taskId: string): ExecutionEventBus {
    const primary = this.#primary.get(taskId);
    if (primary === undefined) {
      const bus = new DefaultExecutionEventBus();
      this.#primary.set(taskId, { bus, busy: true });
      return bus;
    }
    if (primary.busy) {
      const own = new DefaultExecutionEventBus();
      OWN.add(own);
      return own;
    }
    primary.busy = true;
    return primary.bus;
  }

  /** The task's primary bus, if it has one. */
  getByTaskId(taskId: string): ExecutionEventBus | undefined {
    return this.#primary.get(taskId)?.bus;
  }

  /** Forgets the task's primary bus. */
  cleanupByTaskId(taskId: string): void {
    this.#primary.get(taskId)?.bus.removeAllListeners();
    this.#primary.delete(taskId);
  }

  /**
   * Forgets the task's primary bus if `bus` is it and no request is running on it, so a
   * bus lent for a moment (a cancel) is not taken from a request that began meanwhile.
   */
  releaseIdle(taskId: string, bus: ExecutionEventBus): void {
    const primary = this.#primary.get(taskId);
    if (primary?.bus === bus && !primary.busy) {
      this.cleanupByTaskId(taskId);
    }
  }

  /**
   * A request's executor returned. A bus of the request's own is finished here. The
   * primary bus is released for the next request and left to the SDK's usual policy.
   */
  settleByTaskId(taskId: string, bus: ExecutionEventBus): boolean {
    const primary = this.#primary.get(taskId);
    if (primary?.bus === bus) {
      primary.busy = false;
      return false;
    }
    bus.finished();
    return true;
  }
}
