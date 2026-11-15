/**
 * The task as an interface shows it. Both renderers — web and terminal — draw a
 * {@link TaskView}; neither reads A2A events itself. This file is a pure reducer: A2A
 * events in, a new view out.
 */
import type { Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import { EXT, SCHEMAS, readExtension } from '../app/api-server/extensions/index.ts';
import type { FileItem } from './view-files.ts';
import { fileItems, isSpeech } from './view-files.ts';

export type { FileItem, SpeechChunk } from './view-files.ts';

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
  | { readonly kind: 'note'; readonly id: string; readonly text: string }
  /** A file: an image the user attached or the agent made, a voice message. */
  | FileItem;

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

function withFiles(items: readonly TranscriptItem[], files: readonly FileItem[]): TranscriptItem[] {
  return files.reduce<TranscriptItem[]>((all, file) => upsert(all, file), [...items]);
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
      items = withFiles(items, fileItems(message.parts, message.messageId, 'user'));
    } else {
      const item = fromAgentMessage(message, stateOf(TaskState.TASK_STATE_INPUT_REQUIRED, message));
      if (item !== null) {
        items = upsert(items, item);
      }
    }
  }
  for (const artifact of task.artifacts) {
    // What the agent attached is kept on the task; a snapshot lists it after the conversation.
    items = withFiles(items, fileItems(artifact.parts, artifact.artifactId, 'agent'));
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

/**
 * Records what the user just sent, before the harness has answered: the text, when there
 * is any, and the files that go with it.
 */
export function withUserMessage(
  view: TaskView,
  id: string,
  text: string,
  files: readonly FileItem[] = [],
): TaskView {
  const said = text === '' ? view.items : upsert(view.items, { kind: 'user', id, text });
  return { ...view, state: 'working', items: withFiles(said, files) };
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

/**
 * What a surface shows once it reads the stored task: what it already shows, then what the
 * snapshot holds that it did not see. An item is the same when its id is, or a file's
 * address is. An answer this surface streamed has the stream's id, not the stored one, so
 * it stands for the first stored answer with its text — once, and only when that answer
 * is not itself already shown.
 */
function mergedItems(
  mine: readonly TranscriptItem[],
  stored: readonly TranscriptItem[],
): TranscriptItem[] {
  const key = (item: TranscriptItem): string => `${item.kind}:${item.id}`;
  const storedKeys = new Set(stored.map((item) => key(item)));
  const streamed = mine.filter((item) => item.kind === 'agent' && !storedKeys.has(key(item)));
  const shown = (item: TranscriptItem): boolean => {
    const same = mine.some(
      (existing) =>
        existing.kind === item.kind &&
        (existing.id === item.id ||
          ('url' in existing &&
            'url' in item &&
            existing.url !== null &&
            existing.url === item.url)),
    );
    if (same || item.kind !== 'agent') {
      return same;
    }
    const at = streamed.findIndex((existing) => 'text' in existing && existing.text === item.text);
    if (at !== -1) {
      streamed.splice(at, 1);
    }
    return at !== -1;
  };
  return [...mine, ...stored.filter((item) => !shown(item))];
}

/** Applies one A2A stream event to the view. */
export function foldEvent(view: TaskView, event: StreamResponse): TaskView {
  const { payload } = event;
  if (payload?.$case === 'task') {
    const snapshot = viewOfTask(payload.value);
    return { ...snapshot, items: mergedItems(view.items, snapshot.items) };
  }
  if (payload?.$case === 'statusUpdate') {
    return withStatus(view, payload.value.status?.state, payload.value.status?.message);
  }
  if (payload?.$case === 'artifactUpdate') {
    const artifact = payload.value.artifact;
    if (isSpeech(artifact)) {
      // Speech is played, not shown: the session hands it to the surface as it arrives.
      return view;
    }
    const id = artifact?.artifactId ?? '';
    const files = fileItems(artifact?.parts ?? [], id, 'agent');
    if (files.length > 0) {
      return { ...view, items: withFiles(view.items, files) };
    }
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
