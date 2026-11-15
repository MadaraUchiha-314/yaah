/**
 * The core's data model: what a conversation is made of, independent of any protocol or
 * provider. The A2A layer converts to and from these; LLM providers render them.
 */
import type { Json, JsonObject } from '../../kernel/json.ts';

/** Identifies a task. Equal to the A2A task id. */
export type TaskId = string;

/**
 * Identifies one execution point of one task: `<taskId>/<sequence>/<step>/<detail>`.
 *
 * Invariant: stable across retries and replays of the same point, and unique among the
 * points of a task. Every store write is keyed by it and **replaces** what the same key
 * wrote before — the rule that makes a retried step idempotent.
 */
export type StepKey = string;

/** A piece of content in a message or a tool result. */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      /** `image/png`, `audio/wav`, … */
      readonly mediaType: string;
      /** Base64 content, or a URL the content can be fetched from. */
      readonly source:
        | { readonly kind: 'base64'; readonly data: string }
        | { readonly kind: 'url'; readonly url: string };
      readonly name?: string | undefined;
    }
  | { readonly type: 'data'; readonly mediaType: string; readonly data: Json };

/** A model's request to run a tool. */
export interface ToolCall {
  /** Unique within the task; a result is matched to its call by this id. */
  readonly id: string;
  readonly name: string;
  readonly args: Json;
}

/** Why a tool call did not produce a result. */
export interface ToolError {
  /** Stable code: `not-found`, `invalid-arguments`, `denied`, `timeout`, `failed`, `unknown-outcome`. */
  readonly code: string;
  readonly message: string;
}

/** What a tool call produced. Failures are values: they go to the model, not up the stack. */
export type ToolResult =
  | {
      readonly ok: true;
      readonly content: readonly ContentPart[];
      readonly structured?: Json;
      /**
       * Content delivered to the person as an artifact of the task — an image the tool
       * made, for example. It is not shown to the model and not kept in the conversation.
       */
      readonly artifacts?: readonly ContentPart[];
    }
  | { readonly ok: false; readonly error: ToolError };

/** Provider-specific data that must be sent back unchanged (reasoning items, signatures). */
export interface ProviderOpaque {
  readonly provider: string;
  readonly data: Json;
}

/** A half-open range of conversation sequence numbers, `[from, to)`. */
export interface SeqRange {
  readonly from: number;
  readonly to: number;
}

/** What a conversation event carries, before the store assigns it a sequence number. */
export type ConversationEventBody =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'agent';
      readonly parts: readonly ContentPart[];
      /** The inbox item or model turn this message came from. */
      readonly sourceId: string;
      /** True while the task waits for an answer to this message: never compacted. */
      readonly pinned?: boolean | undefined;
    }
  | {
      readonly type: 'tool-call';
      readonly call: ToolCall;
      readonly opaque?: ProviderOpaque | undefined;
    }
  | { readonly type: 'tool-result'; readonly callId: string; readonly result: ToolResult }
  | { readonly type: 'reasoning'; readonly opaque: ProviderOpaque }
  | { readonly type: 'event'; readonly sourceId: string; readonly event: JsonObject }
  | { readonly type: 'summary'; readonly replaces: SeqRange; readonly text: string };

/** One entry of a task's conversation, in order. */
export type ConversationEvent = ConversationEventBody & {
  /** Position in the conversation; assigned by the store, strictly increasing. */
  readonly seq: number;
  /** The step that wrote it. */
  readonly key: StepKey;
};

/** A reference to a task, possibly on another agent. */
export interface TaskRef {
  readonly taskId: TaskId;
  readonly contextId: string;
  /** The id of the agent entity that owns the task. */
  readonly agent: string;
}

/** Someone, or something, with a role on a task. */
export interface Participant {
  readonly id: string;
  readonly role: 'assignee' | 'reporter' | 'watcher' | 'admin';
  readonly kind: 'user' | 'agent';
  readonly displayName?: string | undefined;
}

/** The task as the harness understands it — carried on the A2A task as extension metadata. */
export interface TaskModel {
  readonly name: string;
  readonly type?: string | undefined;
  readonly goal: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly subTasks: readonly TaskRef[];
  readonly parentTasks: readonly TaskRef[];
  readonly participants: readonly Participant[];
  /** 0 for a root task; a sub-task is its parent's depth plus one. */
  readonly depth: number;
  readonly schemaVersion: 1;
}

/** One step of a plan. */
export interface PlanStep {
  /** Unique within the plan. */
  readonly name: string;
  readonly description: string;
  /** Names of the steps that must be done first. */
  readonly dependsOn: readonly string[];
  readonly status: 'pending' | 'in-progress' | 'done' | 'skipped' | 'failed';
  readonly output?: string | undefined;
  readonly linkedTasks: readonly TaskRef[];
}

/** A plan for delivering a task: a directed acyclic graph of steps. */
export interface Plan {
  readonly taskId: TaskId;
  readonly steps: readonly PlanStep[];
  /** Incremented on every change. */
  readonly revision: number;
}

/** What arrived for a task and has not been consumed yet. */
export type InboxPayload =
  | { readonly kind: 'message'; readonly parts: readonly ContentPart[] }
  /** A lifecycle action from the client: end the task without invoking the model. */
  | { readonly kind: 'action'; readonly action: 'complete' }
  /** An event about a delegated sub-task. */
  | { readonly kind: 'event'; readonly event: JsonObject };

/** One item of a task's inbox. */
export interface InboxItem {
  /** Derived from the sender's message id: delivering the same item twice stores it once. */
  readonly id: string;
  readonly taskId: TaskId;
  /** ISO-8601 time the harness accepted it. */
  readonly receivedAt: string;
  /** Abort the current loop iteration instead of waiting for the next one. */
  readonly interrupt: boolean;
  readonly payload: InboxPayload;
}

/** Token counts reported by a provider for one call. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}
