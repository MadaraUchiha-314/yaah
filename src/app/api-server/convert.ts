/**
 * Conversion between A2A wire types (from the official SDK) and the core's own. The core
 * never sees an A2A type; this file is the only place the two meet.
 */
import type { Artifact, Message, Part, TaskStatus } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import type { TaskState as CoreState, TaskSubState } from '../../harness/core/step-runner.ts';
import type { ContentPart, TaskId } from '../../harness/core/types.ts';
import type { Json, JsonObject } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import { z } from 'zod';

import type { TaskLifecycleStatus } from './extensions/index.ts';
import { EXT } from './extensions/index.ts';

const jsonValue: z.ZodType<Json> = z.json();

const TO_A2A: Readonly<Record<CoreState, TaskState>> = {
  working: TaskState.TASK_STATE_WORKING,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  canceled: TaskState.TASK_STATE_CANCELED,
  failed: TaskState.TASK_STATE_FAILED,
};

/** The A2A state for a core state. */
export function toA2aState(state: CoreState): TaskState {
  return TO_A2A[state];
}

/** The core state for an A2A state; states the core never produces map to `working`. */
export function fromA2aState(state?: TaskState): CoreState {
  const found = Object.entries(TO_A2A).find(([, a2a]) => a2a === state);
  const core = found?.[0];
  return core === 'input-required' ||
    core === 'completed' ||
    core === 'canceled' ||
    core === 'failed'
    ? core
    : 'working';
}

function toJson(value: unknown): Json {
  const parsed = jsonValue.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Converts A2A parts to core content. */
export function partsFromA2a(parts: readonly Part[]): ContentPart[] {
  const converted: ContentPart[] = [];
  for (const part of parts) {
    const { content } = part;
    const name = part.filename === '' ? undefined : part.filename;
    if (content?.$case === 'text') {
      converted.push({ type: 'text', text: content.value });
    } else if (content?.$case === 'raw') {
      const data = Buffer.from(content.value).toString('base64');
      const source = { kind: 'base64', data } as const;
      converted.push({ type: 'file', mediaType: part.mediaType, source, name });
    } else if (content?.$case === 'url') {
      const source = { kind: 'url', url: content.value } as const;
      converted.push({ type: 'file', mediaType: part.mediaType, source, name });
    } else if (content?.$case === 'data') {
      const mediaType = part.mediaType === '' ? 'application/json' : part.mediaType;
      const value: unknown = content.value;
      converted.push({ type: 'data', mediaType, data: toJson(value) });
    }
  }
  return converted;
}

function blankPart(): Part {
  return { content: undefined, metadata: undefined, filename: '', mediaType: '' };
}

/** Converts core content to A2A parts. */
export function partsToA2a(parts: readonly ContentPart[]): Part[] {
  return parts.map((part: ContentPart): Part => {
    if (part.type === 'text') {
      return { ...blankPart(), content: { $case: 'text', value: part.text } };
    }
    if (part.type === 'data') {
      return {
        ...blankPart(),
        content: { $case: 'data', value: part.data },
        mediaType: part.mediaType,
      };
    }
    const base = { ...blankPart(), mediaType: part.mediaType, filename: part.name ?? '' };
    return part.source.kind === 'url'
      ? { ...base, content: { $case: 'url', value: part.source.url } }
      : { ...base, content: { $case: 'raw', value: Buffer.from(part.source.data, 'base64') } };
  });
}

/** What {@link agentMessage} needs. */
export interface AgentMessageInit {
  readonly messageId: string;
  readonly taskId: TaskId;
  readonly contextId: string;
  readonly parts: readonly ContentPart[];
  readonly metadata?: JsonObject | undefined;
  readonly extensions?: readonly string[] | undefined;
}

/** Builds an A2A message sent by the agent. */
export function agentMessage(init: AgentMessageInit): Message {
  return {
    messageId: init.messageId,
    taskId: init.taskId,
    contextId: init.contextId,
    role: Role.ROLE_AGENT,
    parts: partsToA2a(init.parts),
    metadata: init.metadata === undefined ? undefined : { ...init.metadata },
    extensions: [...(init.extensions ?? [])],
    referenceTaskIds: [],
  };
}

/** What {@link toA2aStatus} needs. */
export interface StatusInit {
  readonly taskId: TaskId;
  readonly contextId: string;
  readonly state: CoreState;
  readonly subState: TaskSubState | null;
  readonly message: readonly ContentPart[];
  /** Becomes the status message's id; the same id makes a repeated update a no-op. */
  readonly messageId: string;
  readonly timestamp: string;
}

/**
 * Builds the A2A status for a core status. The sub-state of `input-required` rides in the
 * status message's metadata under the task-lifecycle extension, as A2A requires of an
 * extension that refines a state.
 */
export function toA2aStatus(init: StatusInit): TaskStatus {
  const lifecycle: TaskLifecycleStatus | null =
    init.subState === null ? null : { subState: init.subState, schemaVersion: 1 };
  const needsMessage = init.message.length > 0 || lifecycle !== null;
  return {
    state: toA2aState(init.state),
    timestamp: init.timestamp,
    message: needsMessage
      ? agentMessage({
          messageId: init.messageId,
          taskId: init.taskId,
          contextId: init.contextId,
          parts: init.message,
          metadata: lifecycle === null ? undefined : { [EXT.taskLifecycle]: { ...lifecycle } },
          extensions: lifecycle === null ? [] : [EXT.taskLifecycle],
        })
      : undefined,
  };
}

/** Builds the artifact that holds a task's result. */
export function resultArtifact(artifactId: string, parts: readonly ContentPart[]): Artifact {
  return {
    artifactId,
    name: 'response',
    description: '',
    parts: partsToA2a(parts),
    metadata: undefined,
    extensions: [],
  };
}

/** The text of a message's text parts, joined. */
export function messageText(message: Message | undefined): string {
  return (message?.parts ?? [])
    .map((part: Part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

/** Reads a metadata object as JSON, dropping anything that is not. */
export function metadataObject(metadata: unknown): JsonObject {
  const json = toJson(metadata);
  return isJsonObject(json) ? json : {};
}
