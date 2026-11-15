/**
 * The stream hub: how what a running step produces reaches the clients following its
 * task. Each task has a bounded, numbered log; a subscriber names the sequence number it
 * has seen and gets everything after it, then follows live.
 *
 * The hub is a convenience, never the record: status and artifacts are written to the
 * task store before they are published here, so a subscriber that finds the log gone
 * reads the task instead.
 */
import type { Activity, StreamSink, StreamedAudio } from '../harness/core/task-port.ts';
import type { TaskState, TaskSubState } from '../harness/core/step-runner.ts';
import type { ContentPart, StepKey, TaskId } from '../harness/core/types.ts';

/** Something that happened on a task, for the clients following it. */
export type HubEvent =
  /** The task's status changed. The task store already holds it. */
  | {
      readonly type: 'status';
      readonly state: TaskState;
      readonly subState: TaskSubState | null;
      /** The id of the status message, equal to the step key that produced it. */
      readonly messageId: string;
    }
  /** A result of the task was stored. */
  | {
      readonly type: 'artifact';
      readonly artifactId: string;
      readonly parts: readonly ContentPart[];
      /** The artifact's name; `response` when absent. */
      readonly name?: string | undefined;
    }
  /** A piece of the model's answer, as step `key` produces it. */
  | { readonly type: 'delta'; readonly key: StepKey; readonly text: string }
  /** Everything step `key` streamed so far is void: the step is being attempted again. */
  | { readonly type: 'reset'; readonly key: StepKey }
  /** The agent started or finished something worth showing. */
  | { readonly type: 'activity'; readonly activity: Activity }
  /** A piece of the spoken form of the answer of step `key`. */
  | { readonly type: 'audio'; readonly key: StepKey; readonly chunk: StreamedAudio };

/** A hub event with its position in the task's log. */
export interface SequencedHubEvent {
  /** Starts at 1 and increases by one per event of the task. */
  readonly seq: number;
  readonly event: HubEvent;
}

interface TaskLog {
  head: number;
  events: SequencedHubEvent[];
  waiters: Set<() => void>;
}

/** How many events a task's log keeps before dropping the oldest. */
const DEFAULT_CAPACITY = 2000;
/** How long a finished or resting task's log stays for a subscriber that comes late. */
const DEFAULT_RETAIN_MS = 30_000;
const FINAL: ReadonlySet<TaskState> = new Set(['completed', 'canceled', 'failed']);
/** A task waits here between turns; an abandoned conversation may never leave it. */
const RESTING: ReadonlySet<TaskState> = new Set(['input-required']);

/** Keeps a timer from holding the process open, where timers can do that. */
function unref(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const { unref: release } = timer;
    if (typeof release === 'function') {
      release.call(timer);
    }
  }
}

/** An in-process stream hub. One harness process serves one data store. */
export class StreamHub implements StreamSink {
  readonly #logs = new Map<TaskId, TaskLog>();
  readonly #capacity: number;
  readonly #retainMs: number;

  /**
   * @param retainMs How long a task's log is kept after its final status, and its events
   *   after it comes to rest: long enough for a request that started following just
   *   before the end to read it.
   */
  constructor(capacity: number = DEFAULT_CAPACITY, retainMs: number = DEFAULT_RETAIN_MS) {
    this.#capacity = capacity;
    this.#retainMs = retainMs;
  }

  /** How many tasks have a log. */
  get size(): number {
    return this.#logs.size;
  }

  /** Appends to the task's log and returns the event's sequence number. */
  publish(taskId: TaskId, event: HubEvent): number {
    const log = this.#log(taskId);
    log.head += 1;
    log.events.push({ seq: log.head, event });
    if (log.events.length > this.#capacity) {
      log.events.splice(0, log.events.length - this.#capacity);
    }
    for (const wake of log.waiters) {
      wake();
    }
    if (event.type === 'status' && FINAL.has(event.state)) {
      this.#dropLater(taskId, log);
    } else if (event.type === 'status' && RESTING.has(event.state)) {
      this.#clearLater(log);
    }
    return log.head;
  }

  /** The sequence number of the task's newest event; 0 when there is none. */
  head(taskId: TaskId): number {
    return this.#logs.get(taskId)?.head ?? 0;
  }

  /** The logged events after `afterSeq`. */
  replay(taskId: TaskId, afterSeq: number): SequencedHubEvent[] {
    const events = this.#logs.get(taskId)?.events ?? [];
    return events.filter((entry: SequencedHubEvent) => entry.seq > afterSeq);
  }

  /** Drops a task's logged events. Numbering continues, so old cursors stay valid. */
  clear(taskId: TaskId): void {
    const log = this.#logs.get(taskId);
    if (log !== undefined) {
      log.events = [];
    }
  }

  /** Replays everything after `afterSeq`, then follows live until `signal` aborts. */
  async *subscribe(
    taskId: TaskId,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<SequencedHubEvent> {
    const log = this.#log(taskId);
    let cursor = afterSeq;
    try {
      while (!signal.aborted) {
        const batch = this.replay(taskId, cursor);
        for (const entry of batch) {
          if (signal.aborted) {
            return;
          }
          cursor = entry.seq;
          yield entry;
        }
        if (batch.length === 0) {
          // oxlint-disable-next-line no-await-in-loop -- waiting for the next publish
          await this.#nextPublish(log, signal);
        }
      }
    } finally {
      // Following a task nothing was published for leaves no log behind.
      if (log.head === 0 && log.waiters.size === 0 && this.#logs.get(taskId) === log) {
        this.#logs.delete(taskId);
      }
    }
  }

  delta(taskId: TaskId, key: StepKey, text: string): void {
    this.publish(taskId, { type: 'delta', key, text });
  }

  reset(taskId: TaskId, key: StepKey): void {
    this.publish(taskId, { type: 'reset', key });
  }

  activity(taskId: TaskId, activity: Activity): void {
    this.publish(taskId, { type: 'activity', activity });
  }

  audio(taskId: TaskId, key: StepKey, chunk: StreamedAudio): void {
    this.publish(taskId, { type: 'audio', key, chunk });
  }

  #log(taskId: TaskId): TaskLog {
    let log = this.#logs.get(taskId);
    if (log === undefined) {
      log = { head: 0, events: [], waiters: new Set() };
      this.#logs.set(taskId, log);
    }
    return log;
  }

  /** Forgets the task's log `retainMs` after its final status, unless a newer log took its place. */
  #dropLater(taskId: TaskId, log: TaskLog): void {
    unref(
      setTimeout(() => {
        if (this.#logs.get(taskId) === log) {
          this.#logs.delete(taskId);
        }
      }, this.#retainMs),
    );
  }

  /**
   * Empties the log of a resting task `retainMs` later, unless a new turn published since.
   * The numbering stays, so a cursor taken from the head before the next turn is valid.
   */
  #clearLater(log: TaskLog): void {
    const rested = log.head;
    unref(
      setTimeout(() => {
        if (log.head === rested) {
          log.events = [];
        }
      }, this.#retainMs),
    );
  }

  #nextPublish(log: TaskLog, signal: AbortSignal): Promise<void> {
    return new Promise((resolve: () => void) => {
      const wake = (): void => {
        log.waiters.delete(wake);
        signal.removeEventListener('abort', wake);
        resolve();
      };
      log.waiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}
