/**
 * The task as an interface shows it. Both renderers — web and terminal — draw a
 * {@link TaskView}; neither reads A2A events itself. This file is a pure reducer: A2A
 * events in, a new view out.
 */
import type { Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import { EXT, SCHEMAS, readExtension } from '../app/api-server/extensions/index.ts';

/** The media type of a part that carries A2UI messages. */
export const A2UI_MEDIA_TYPE = 'application/a2ui+json';

/** One entry of the transcript. */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly text: string;
      /** True while the text is still arriving. */
      readonly streaming: boolean;
      /** A2UI message batches carried by this answer, in order. */
      readonly a2ui: readonly unknown[];
    }
  /** The agent asked the user for input. */
  | { readonly kind: 'ask'; readonly id: string; readonly text: string }
  /** A tool call, as it starts and finishes. */
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly name: string;
      readonly done: boolean;
      readonly ok: boolean;
      readonly durationMs: number | null;
    }
  /** Something said about the conversation rather than in it: a command's reply. */
  | { readonly kind: 'note'; readonly id: string; readonly text: string };

/** What state the task is in, in the interface's terms. */
export type ViewState =
  | 'idle'
  | 'working'
  | 'awaiting-next-interaction'
  | 'awaiting-user-input'
  | 'completed'
  | 'canceled'
  | 'failed';

/** Everything an interface needs to draw one task. */
export interface TaskView {
  readonly taskId: string | null;
  readonly contextId: string | null;
  readonly state: ViewState;
  readonly items: readonly TranscriptItem[];
  /** The task's workflow in the Temporal Web UI, when the harness runs on Temporal. */
  readonly workflowUrl: string | null;
}

/** The view before anything was said. */
export const EMPTY_VIEW: TaskView = {
  taskId: null,
  contextId: null,
  state: 'idle',
  items: [],
  workflowUrl: null,
};

/** Whether the task can still be sent a message. */
export function isOpen(view: TaskView): boolean {
  return view.state !== 'completed' && view.state !== 'canceled' && view.state !== 'failed';
}

function textOf(parts: readonly Part[]): string {
  return parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join('');
}

function a2uiOf(parts: readonly Part[]): unknown[] {
  const batches: unknown[] = [];
  for (const part of parts) {
    if (part.mediaType === A2UI_MEDIA_TYPE && part.content?.$case === 'data') {
      const value: unknown = part.content.value;
      batches.push(value);
    }
  }
  return batches;
}

function stateOf(state: TaskState | undefined, message: Message | undefined): ViewState {
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    const lifecycle = readExtension(
      message?.metadata,
      EXT.taskLifecycle,
      SCHEMAS.taskLifecycleStatus,
    );
    // A sub-state this interface does not know is treated as "waiting for the next message".
    return lifecycle?.subState === 'awaiting-user-input'
      ? 'awaiting-user-input'
      : 'awaiting-next-interaction';
  }
  if (state === TaskState.TASK_STATE_COMPLETED) {
    return 'completed';
  }
  if (state === TaskState.TASK_STATE_CANCELED) {
    return 'canceled';
  }
  return state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED
    ? 'failed'
    : 'working';
}

function upsert(items: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex(
    (existing) => existing.kind === item.kind && existing.id === item.id,
  );
  return index === -1
    ? [...items, item]
    : items.map((existing, at) => (at === index ? item : existing));
}

/** The transcript item a stored agent message stands for, or null when it adds nothing. */
function fromAgentMessage(message: Message, state: ViewState): TranscriptItem | null {
  const text = textOf(message.parts);
  const a2ui = a2uiOf(message.parts);
  if (text === '' && a2ui.length === 0) {
    return null;
  }
  return state === 'awaiting-user-input'
    ? { kind: 'ask', id: message.messageId, text }
    : { kind: 'agent', id: message.messageId, text, streaming: false, a2ui };
}

/** Builds the view of a task from its stored form: the snapshot a surface starts from. */
export function viewOfTask(task: Task): TaskView {
  let items: TranscriptItem[] = [];
  for (const message of task.history) {
    if (message.role === Role.ROLE_USER) {
      const text = textOf(message.parts);
      if (text !== '') {
        items = upsert(items, { kind: 'user', id: message.messageId, text });
      }
    } else {
      const item = fromAgentMessage(message, stateOf(TaskState.TASK_STATE_INPUT_REQUIRED, message));
      if (item !== null) {
        items = upsert(items, item);
      }
    }
  }
  const link = readExtension(task.metadata, EXT.durableExecution, SCHEMAS.durableExecutionTask);
  return {
    taskId: task.id,
    contextId: task.contextId,
    state: stateOf(task.status?.state, task.status?.message),
    items,
    workflowUrl: link?.url ?? null,
  };
}

/** Records what the user just sent, before the harness has answered. */
export function withUserMessage(view: TaskView, id: string, text: string): TaskView {
  return { ...view, state: 'working', items: upsert(view.items, { kind: 'user', id, text }) };
}

function withStatus(
  view: TaskView,
  state: TaskState | undefined,
  message: Message | undefined,
): TaskView {
  const activity = readExtension(message?.metadata, EXT.activity, SCHEMAS.activityStatus);
  if (activity !== null) {
    const item: TranscriptItem = {
      kind: 'tool',
      id: activity.id,
      name: activity.name,
      done: activity.phase === 'finished',
      ok: activity.ok ?? true,
      durationMs: activity.durationMs ?? null,
    };
    return { ...view, items: upsert(view.items, item) };
  }
  const next = stateOf(state, message);
  const item = message === undefined ? null : fromAgentMessage(message, next);
  // The answer was already shown as it streamed; the status that closes the turn repeats it.
  const last = view.items.findLast((existing) => existing.kind === 'agent');
  const repeated = item?.kind === 'agent' && last?.kind === 'agent' && last.text === item.text;
  const settled = view.items.map((existing): TranscriptItem =>
    existing.kind === 'agent' && existing.streaming ? { ...existing, streaming: false } : existing,
  );
  return {
    ...view,
    state: next,
    items: item === null || repeated ? settled : upsert(settled, item),
  };
}

/** Applies one A2A stream event to the view. */
export function foldEvent(view: TaskView, event: StreamResponse): TaskView {
  const { payload } = event;
  if (payload?.$case === 'task') {
    const snapshot = viewOfTask(payload.value);
    // Keep what this surface already shows; the snapshot adds what it did not see.
    const shown = (item: TranscriptItem): boolean =>
      view.items.some(
        (mine) =>
          mine.kind === item.kind &&
          (mine.id === item.id || ('text' in mine && 'text' in item && mine.text === item.text)),
      );
    const items = [...view.items, ...snapshot.items.filter((item) => !shown(item))];
    return { ...snapshot, items };
  }
  if (payload?.$case === 'statusUpdate') {
    return withStatus(view, payload.value.status?.state, payload.value.status?.message);
  }
  if (payload?.$case === 'artifactUpdate') {
    const artifact = payload.value.artifact;
    const id = artifact?.artifactId ?? '';
    const before = view.items.find((item) => item.kind === 'agent' && item.id === id);
    const text = textOf(artifact?.parts ?? []);
    const a2ui = a2uiOf(artifact?.parts ?? []);
    const previous = before?.kind === 'agent' ? before : null;
    const item: TranscriptItem = payload.value.append
      ? {
          kind: 'agent',
          id,
          text: (previous?.text ?? '') + text,
          streaming: true,
          a2ui: [...(previous?.a2ui ?? []), ...a2ui],
        }
      : { kind: 'agent', id, text, streaming: !payload.value.lastChunk, a2ui };
    if (!payload.value.append && text === '' && a2ui.length === 0) {
      // A reset: the step starts over, and what it had streamed is void.
      const kept = view.items.filter(
        (existing) => !(existing.kind === 'agent' && existing.id === id),
      );
      return { ...view, items: kept };
    }
    return { ...view, items: upsert(view.items, item) };
  }
  if (payload?.$case === 'message') {
    const text = textOf(payload.value.parts);
    return {
      ...view,
      items: upsert(view.items, { kind: 'note', id: payload.value.messageId, text }),
    };
  }
  return view;
}
