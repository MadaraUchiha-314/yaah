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

/** An in-process stream hub. One harness process serves one data store. */
export class StreamHub implements StreamSink {
  readonly #logs = new Map<TaskId, TaskLog>();
  readonly #capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = capacity;
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
