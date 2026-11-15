/**
 * yaah's A2A extensions: everything yaah-specific on the wire. Each has a URI, a schema
 * and a row in the agent card. A client that does not know an extension still sees
 * plain, conformant A2A.
 *
 * The schemas here are the source of the JSON Schemas published under
 * `specs/a2a-extensions/`; a contract test holds the two together.
 */
import { z } from 'zod';

import type { Participant, TaskModel, TaskRef } from '../../../harness/core/types.ts';
import { YaahError } from '../../../kernel/errors.ts';
import type { Json } from '../../../kernel/json.ts';

/** The base every yaah extension URI starts with. Changing it breaks clients. */
export const EXTENSION_BASE = 'https://github.com/MadaraUchiha-314/yaah/extensions';

/** The URIs of yaah's extensions. The version is part of the URI. */
export const EXT: {
  readonly taskLifecycle: string;
  readonly taskModel: string;
  readonly inboxEvents: string;
  readonly commands: string;
  readonly durableExecution: string;
} = {
  taskLifecycle: `${EXTENSION_BASE}/task-lifecycle/v1`,
  taskModel: `${EXTENSION_BASE}/task-model/v1`,
  inboxEvents: `${EXTENSION_BASE}/inbox-events/v1`,
  commands: `${EXTENSION_BASE}/commands/v1`,
  durableExecution: `${EXTENSION_BASE}/durable-execution/v1`,
};

/** The media type of a part that carries an A2A event as inbox input. */
export const A2A_EVENT_MEDIA_TYPE = 'application/a2a+json';

/** Task-lifecycle data a client puts on a message. */
export interface TaskLifecycleRequest {
  /** On the message that creates a root task: keep it open after each response. */
  readonly longRunning?: boolean | undefined;
  /** On a message to an open task: end it without invoking the model. */
  readonly action?: 'complete' | undefined;
}

/** Task-lifecycle data the harness puts on a status message. */
export interface TaskLifecycleStatus {
  /**
   * Why the task rests in `input-required`. An open enumeration: a client MUST treat a
   * value it does not know as `awaiting-next-interaction`.
   */
  readonly subState: string;
  readonly schemaVersion: 1;
}

/** Task-model data a client may put on the message that creates a task. */
export interface TaskModelRequest {
  readonly name?: string | undefined;
  readonly type?: string | undefined;
  readonly goal?: string | undefined;
  readonly description?: string | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly participants?: readonly Participant[] | undefined;
  /** Set by a delegating agent: the task this one was spawned from. */
  readonly parentTasks?: readonly TaskRef[] | undefined;
  /** Set by a delegating agent: the parent's depth plus one. */
  readonly depth?: number | undefined;
}

/** Inbox-events data on a message that carries an A2A event as a data part. */
export interface InboxEventsRequest {
  /** Abort the task's current iteration instead of waiting for the next one. */
  readonly interrupt?: boolean | undefined;
}

/** One command, as listed in the agent card. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly scope: 'harness' | 'surface';
}

/** The outcome of a command, on the reply message. */
export interface CommandOutcome {
  readonly command: string;
  readonly status: 'executed' | 'failed' | 'unknown';
}

/** Durable-execution parameters in the agent card. */
export interface DurableExecutionParams {
  readonly mode: 'none' | 'temporal-embedded' | 'temporal-remote';
  /** The Temporal Web UI of the harness's namespace, or null in mode `none`. */
  readonly dashboardUrl: string | null;
}

/** Durable-execution data on a task. */
export interface DurableExecutionTask {
  readonly workflowId: string;
  readonly runId: string;
  /** The task's workflow in the Temporal Web UI. */
  readonly url: string;
}

const taskRef: z.ZodType<TaskRef> = z.strictObject({
  taskId: z.string(),
  contextId: z.string(),
  agent: z.string(),
});

const participant: z.ZodType<Participant> = z.strictObject({
  id: z.string(),
  role: z.enum(['assignee', 'reporter', 'watcher', 'admin']),
  kind: z.enum(['user', 'agent']),
  displayName: z.string().optional(),
});

/** The schema of each extension payload. */
export interface ExtensionSchemas {
  readonly taskLifecycleRequest: z.ZodType<TaskLifecycleRequest>;
  readonly taskLifecycleStatus: z.ZodType<TaskLifecycleStatus>;
  readonly taskModel: z.ZodType<TaskModel>;
  readonly taskModelRequest: z.ZodType<TaskModelRequest>;
  readonly inboxEventsRequest: z.ZodType<InboxEventsRequest>;
  readonly commandsParams: z.ZodType<{ readonly commands: readonly CommandInfo[] }>;
  readonly commandOutcome: z.ZodType<CommandOutcome>;
  readonly durableExecutionParams: z.ZodType<DurableExecutionParams>;
  readonly durableExecutionTask: z.ZodType<DurableExecutionTask>;
}

/** The schema of each extension payload, by where it rides. */
export const SCHEMAS: ExtensionSchemas = {
  taskLifecycleRequest: z.strictObject({
    longRunning: z.boolean().optional(),
    action: z.enum(['complete']).optional(),
  }),
  taskLifecycleStatus: z.strictObject({
    subState: z.string(),
    schemaVersion: z.literal(1),
  }),
  taskModel: z.strictObject({
    name: z.string(),
    type: z.string().optional(),
    goal: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    subTasks: z.array(taskRef),
    parentTasks: z.array(taskRef),
    participants: z.array(participant),
    depth: z.int().min(0),
    schemaVersion: z.literal(1),
  }),
  taskModelRequest: z.strictObject({
    name: z.string().optional(),
    type: z.string().optional(),
    goal: z.string().optional(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    participants: z.array(participant).optional(),
    parentTasks: z.array(taskRef).optional(),
    depth: z.int().min(0).optional(),
  }),
  inboxEventsRequest: z.strictObject({
    interrupt: z.boolean().optional(),
  }),
  commandsParams: z.strictObject({
    commands: z.array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        scope: z.enum(['harness', 'surface']),
      }),
    ),
  }),
  commandOutcome: z.strictObject({
    command: z.string(),
    status: z.enum(['executed', 'failed', 'unknown']),
  }),
  durableExecutionParams: z.strictObject({
    mode: z.enum(['none', 'temporal-embedded', 'temporal-remote']),
    dashboardUrl: z.string().nullable(),
  }),
  durableExecutionTask: z.strictObject({
    workflowId: z.string(),
    runId: z.string(),
    url: z.string(),
  }),
};

/** A payload under an extension URI did not match the extension's schema. */
export class InvalidExtensionError extends YaahError {
  readonly uri: string;

  constructor(uri: string, reason: string) {
    super('extension.invalid', `invalid data for extension ${uri}: ${reason}`);
    this.uri = uri;
  }
}

/**
 * Reads one extension's payload from a metadata object.
 *
 * @returns the validated payload, or null when the metadata carries nothing for `uri`.
 * @throws InvalidExtensionError when something is there and does not match.
 */
export function readExtension<T>(metadata: unknown, uri: string, schema: z.ZodType<T>): T | null {
  if (typeof metadata !== 'object' || metadata === null || !(uri in metadata)) {
    return null;
  }
  const fields: Readonly<Record<string, unknown>> = { ...metadata };
  const parsed = schema.safeParse(fields[uri]);
  if (!parsed.success) {
    throw new InvalidExtensionError(uri, parsed.error.issues[0]?.message ?? 'invalid');
  }
  return parsed.data;
}

const jsonValue: z.ZodType<Json> = z.json();

/** The JSON Schemas of the extension payloads, by repo-relative spec path. */
export function extensionJsonSchemas(): Readonly<Record<string, Json>> {
  const file = (name: string): string => `specs/a2a-extensions/${name}.schema.json`;
  const schema = (id: string, parts: Readonly<Record<string, z.ZodType>>): Json =>
    jsonValue.parse({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: id,
      $defs: Object.fromEntries(
        Object.entries(parts).map(([name, part]) => [name, z.toJSONSchema(part, { io: 'input' })]),
      ),
    });
  return {
    [file('task-lifecycle.v1')]: schema(EXT.taskLifecycle, {
      messageMetadata: SCHEMAS.taskLifecycleRequest,
      statusMessageMetadata: SCHEMAS.taskLifecycleStatus,
    }),
    [file('task-model.v1')]: schema(EXT.taskModel, {
      taskMetadata: SCHEMAS.taskModel,
      messageMetadata: SCHEMAS.taskModelRequest,
    }),
    [file('inbox-events.v1')]: schema(EXT.inboxEvents, {
      messageMetadata: SCHEMAS.inboxEventsRequest,
    }),
    [file('commands.v1')]: schema(EXT.commands, {
      agentCardParams: SCHEMAS.commandsParams,
      messageMetadata: SCHEMAS.commandOutcome,
    }),
    [file('durable-execution.v1')]: schema(EXT.durableExecution, {
      agentCardParams: SCHEMAS.durableExecutionParams,
      taskMetadata: SCHEMAS.durableExecutionTask,
    }),
  };
}
