/**
 * The persistence interfaces of the core — one per concern, so that each can be replaced
 * by a plugin on its own.
 *
 * Exactly-once behaviour does not rest on a transaction across stores (a replaced store
 * may live elsewhere). It rests on one rule every implementation must keep: **a write is
 * keyed by the step that makes it and replaces what that step wrote before.**
 */
import type { Json } from '../../kernel/json.ts';
import type {
  ConversationEvent,
  ConversationEventBody,
  InboxItem,
  Plan,
  SeqRange,
  StepKey,
  TaskId,
} from './types.ts';

/** A task's conversation: messages, tool calls and results, summaries. */
export interface ConversationStore {
  /**
   * Writes the events produced by step `key`, replacing any events the same key wrote
   * earlier. Replaced events keep their position; new ones are appended.
   */
  put(taskId: TaskId, key: StepKey, events: readonly ConversationEventBody[]): Promise<void>;
  /** The conversation in order, optionally limited to a sequence range. */
  read(taskId: TaskId, range?: SeqRange): Promise<readonly ConversationEvent[]>;
}

/** Arbitrary per-task data the agent manages. */
export interface StateStore {
  get(taskId: TaskId, name: string): Promise<Json | undefined>;
  /** Sets `name`. Repeating the call with the same `key` is a no-op beyond the first. */
  set(taskId: TaskId, key: StepKey, name: string, value: Json): Promise<void>;
  /** Every name set for the task, sorted. */
  names(taskId: TaskId): Promise<readonly string[]>;
}

/** The current plan of each task. */
export interface PlanStore {
  load(taskId: TaskId): Promise<Plan | undefined>;
  /** Saves `plan`. Repeating the call with the same `key` does not bump anything twice. */
  save(key: StepKey, plan: Plan): Promise<void>;
}

/** Items accepted for a task and not yet consumed by its loop. */
export interface InboxStore {
  /** Stores an item. Returns `duplicate` when an item with the same id exists already. */
  put(item: InboxItem): Promise<'stored' | 'duplicate'>;
  /** Fetches items by id, in the order given; unknown ids are skipped. */
  get(ids: readonly string[]): Promise<readonly InboxItem[]>;
  /** Unprocessed items in arrival order — of one task, or of all. */
  pending(taskId?: TaskId): Promise<readonly InboxItem[]>;
  /** Marks items consumed. Marking twice is harmless. */
  markProcessed(ids: readonly string[]): Promise<void>;
}

/** The record of a finished step, kept so that a restart does not run it again. */
export interface StepRecord {
  readonly key: StepKey;
  readonly result: Json;
}

/** Completed steps of in-process runs. (Temporal keeps its own history.) */
export interface StepJournal {
  get(key: StepKey): Promise<StepRecord | undefined>;
  /** Records a result. The first record for a key wins; later ones are ignored. */
  record(key: StepKey, result: Json): Promise<void>;
  /** Every recorded step of a task, in recording order. */
  list(taskId: TaskId): Promise<readonly StepRecord[]>;
}

/** The five stores together — what a persistence backend provides. */
export interface Persistence {
  readonly conversation: ConversationStore;
  readonly state: StateStore;
  readonly plan: PlanStore;
  readonly inbox: InboxStore;
  readonly journal: StepJournal;
}
