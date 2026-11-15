/**
 * `invoke_agent`: the tool through which the model hands work to another agent. The
 * call goes through the agent interface — A2A — whether the agent is remote or this
 * harness itself with a fresh context.
 */
import type { Message, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import { messageText } from '../../app/api-server/convert.ts';
import type { TaskModelRequest } from '../../app/api-server/extensions/index.ts';
import { EXT } from '../../app/api-server/extensions/index.ts';
import type { Json } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import { MAX_DESCRIPTION_LENGTH, sanitizeDescription } from '../core/context/builder.ts';
import type { TaskPort } from '../core/task-port.ts';
import type { TaskRef, ToolResult } from '../core/types.ts';
import type { Tool, ToolCallContext } from '../tools/types.ts';
import { errorResult, textResult } from '../tools/types.ts';
import type { Agent } from './types.ts';

/** The name of the delegation tool. */
export const INVOKE_AGENT = 'invoke_agent';

/** What the tool works with. */
export interface InvokeAgentDeps {
  readonly registry: EntityRegistry;
  readonly tasks: TaskPort;
  /** How deep delegation may go: a root task is depth 0. */
  readonly maxDepth: number;
}

/** One message handed to an agent: a piece of work, or a question. */
export interface Delegation {
  readonly message: string;
  /** The agent's task this message continues. Empty starts a new one. */
  readonly taskId: string;
  /** Record the agent's task among the sub-tasks of the caller's task. */
  readonly track: boolean;
  /** What the agent is told about the task it creates: name, goal, acceptance criteria. */
  readonly task?: TaskModelRequest | undefined;
  /** The result text when the agent asks back. Defaults to pointing at `invoke_agent`. */
  readonly needsInput?: ((question: string, taskId: string) => string) | undefined;
}

/** What a delegation needs to know about the call it serves. */
export type DelegationContext = Pick<ToolCallContext, 'taskId' | 'key' | 'signal'>;

const ENDED: Readonly<Record<number, string>> = {
  [TaskState.TASK_STATE_FAILED]: 'failed',
  [TaskState.TASK_STATE_CANCELED]: 'canceled',
  [TaskState.TASK_STATE_REJECTED]: 'rejected',
};

/** What one call to an agent came to. */
interface Outcome {
  subTask: { taskId: string; contextId: string } | null;
  state: TaskState;
  statusText: string;
  /** The text of each artifact, by id, as last streamed. */
  artifacts: Map<string, string>;
  reply: string;
}

function partsText(
  parts: readonly { content?: { $case: string; value: unknown } | undefined }[],
): string {
  return parts
    .map((part) =>
      part.content?.$case === 'text' && typeof part.content.value === 'string'
        ? part.content.value
        : '',
    )
    .join('');
}

/** Folds a whole task into the outcome: its state, its status message and its artifacts. */
function foldTask(outcome: Outcome, task: Task): void {
  outcome.subTask = { taskId: task.id, contextId: task.contextId };
  outcome.state = task.status?.state ?? outcome.state;
  if (task.status?.message !== undefined) {
    outcome.statusText = messageText(task.status.message);
  }
  for (const artifact of task.artifacts) {
    outcome.artifacts.set(artifact.artifactId, partsText(artifact.parts));
  }
}

/** Folds one stream event into the outcome. */
function fold(outcome: Outcome, event: StreamResponse): void {
  const { payload } = event;
  if (payload?.$case === 'task') {
    foldTask(outcome, payload.value);
  } else if (payload?.$case === 'statusUpdate') {
    outcome.state = payload.value.status?.state ?? outcome.state;
    outcome.statusText = messageText(payload.value.status?.message);
  } else if (payload?.$case === 'artifactUpdate') {
    const id = payload.value.artifact?.artifactId ?? '';
    const text = partsText(payload.value.artifact?.parts ?? []);
    outcome.artifacts.set(
      id,
      payload.value.append ? (outcome.artifacts.get(id) ?? '') + text : text,
    );
  } else if (payload?.$case === 'message') {
    outcome.reply = messageText(payload.value);
  }
}

function toResult(outcome: Outcome, request: Delegation): ToolResult {
  const produced = [...outcome.artifacts.values()].filter((text) => text !== '').join('\n\n');
  const text = produced === '' ? outcome.statusText || outcome.reply : produced;
  if (outcome.state === TaskState.TASK_STATE_INPUT_REQUIRED && outcome.subTask !== null) {
    const { taskId } = outcome.subTask;
    const question = outcome.statusText;
    const asked = request.needsInput?.(question, taskId);
    return textResult(asked ?? t('agent.invoke.needs-input', { question, taskId }));
  }
  const ended = ENDED[outcome.state];
  return ended === undefined
    ? textResult(text)
    : errorResult(ended, t('agent.invoke.ended', { state: ended, text }));
}

/** The most of an agent's card shown in the list: one agent cannot crowd out the rest. */
const MAX_AGENT_LINE = 200;

/** One line per agent: its id, then what its card says, on one line and capped. */
function agentsList(registry: EntityRegistry): string {
  const lines = registry.list('agent').map((agent: Agent) => {
    const skills = agent.skills.map((skill) => skill.name).join(', ');
    const card = `${agent.name}: ${agent.description}${skills === '' ? '' : ` (skills: ${skills})`}`;
    const about = sanitizeDescription(card.replaceAll(/\s+/gu, ' '), MAX_AGENT_LINE);
    return `- ${agent.ref.id} — ${about}`;
  });
  return lines.length === 0
    ? t('agent.invoke.none')
    : `${t('agent.invoke.agents')}\n${lines.join('\n')}`;
}

function field(args: Json, name: string): string {
  const value = isJsonObject(args) ? args[name] : undefined;
  return typeof value === 'string' ? value : '';
}

/** Records the sub-task on the parent, once. */
async function link(deps: InvokeAgentDeps, ctx: DelegationContext, ref: TaskRef): Promise<void> {
  const parent = await deps.tasks.load(ctx.taskId);
  if (!parent.model.subTasks.some((known) => known.taskId === ref.taskId)) {
    const subTasks = [...parent.model.subTasks, ref];
    await deps.tasks.setModel(ctx.taskId, ctx.key, { ...parent.model, subTasks });
  }
}

async function call(
  deps: InvokeAgentDeps,
  agent: Agent,
  request: Delegation,
  ctx: DelegationContext,
): Promise<ToolResult> {
  const parent = await deps.tasks.load(ctx.taskId);
  const continued = request.taskId;
  const lineage: TaskModelRequest = {
    ...request.task,
    parentTasks: [{ taskId: ctx.taskId, contextId: parent.contextId, agent: 'self' }],
    depth: parent.model.depth + 1,
  };
  const message: Message = {
    messageId: ctx.key,
    contextId: '',
    taskId: continued,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: request.message },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ],
    metadata: continued === '' ? { [EXT.taskModel]: lineage } : undefined,
    extensions: continued === '' ? [EXT.taskModel] : [],
    referenceTaskIds: [],
  };
  const outcome: Outcome = {
    subTask: null,
    state: TaskState.TASK_STATE_COMPLETED,
    statusText: '',
    artifacts: new Map(),
    reply: '',
  };
  let linked = !request.track;
  for await (const event of agent.sendMessage(message, {
    extensions: message.extensions,
    signal: ctx.signal,
  })) {
    fold(outcome, event);
    if (!linked && outcome.subTask !== null) {
      linked = true;
      // oxlint-disable-next-line no-await-in-loop -- once, on the first event that names the task
      await link(deps, ctx, { ...outcome.subTask, agent: agent.ref.id });
    }
  }
  return toResult(outcome, request);
}

/**
 * Sends `request` to the agent registered as `agentId` and waits for what comes of it.
 * Every refusal and every failure is a result, never a throw: an unknown agent
 * (`not-found`), a task already at the delegation depth limit (`depth-limit`), an agent
 * that cannot be reached (`unavailable`), and a task of the agent's that ended badly.
 */
export async function delegate(
  deps: InvokeAgentDeps,
  agentId: string,
  request: Delegation,
  ctx: DelegationContext,
): Promise<ToolResult> {
  const ref = { kind: 'agent', id: agentId, version: null } as const;
  if (!deps.registry.has(ref)) {
    const available = deps.registry
      .list('agent')
      .map((agent: Agent) => agent.ref.id)
      .join(', ');
    return errorResult('not-found', t('agent.invoke.unknown', { agent: agentId, available }));
  }
  const { model } = await deps.tasks.load(ctx.taskId);
  if (model.depth + 1 > deps.maxDepth) {
    const message = t('agent.invoke.depth', { depth: model.depth, limit: deps.maxDepth });
    return errorResult('depth-limit', message);
  }
  try {
    const result = await call(deps, deps.registry.resolve(ref), request, ctx);
    return result;
  } catch (error) {
    return errorResult('unavailable', error instanceof Error ? error.message : String(error));
  }
}

/** Builds the `invoke_agent` tool. Its description lists the agents registered right now. */
export function createInvokeAgentTool(deps: InvokeAgentDeps): Tool {
  return {
    ref: { kind: 'tool', id: INVOKE_AGENT, version: null },
    locality: { type: 'local' },
    get description(): string {
      return `${t('agent.invoke.description')}\n\n${agentsList(deps.registry)}`;
    },
    // Each line is capped on its own; the whole grows with the list, so none is cut off.
    get maxDescriptionLength(): number {
      return deps.registry
        .list('agent')
        .reduce(
          (total: number, agent: Agent) => total + agent.ref.id.length + MAX_AGENT_LINE + 5,
          MAX_DESCRIPTION_LENGTH,
        );
    },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        taskId: { type: 'string' },
      },
      required: ['agent', 'message'],
      additionalProperties: false,
    },
    // A delegated task may already have acted when the outcome is lost: never repeat it.
    retrySafe: false,
    invoke: (args: Json, ctx: ToolCallContext): Promise<ToolResult> =>
      delegate(
        deps,
        field(args, 'agent'),
        { message: field(args, 'message'), taskId: field(args, 'taskId'), track: true },
        ctx,
      ),
  };
}
