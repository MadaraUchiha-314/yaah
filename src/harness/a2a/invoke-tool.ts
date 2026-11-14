/**
 * `invoke_agent`: the tool through which the model hands work to another agent. The
 * call goes through the agent interface — A2A — whether the agent is remote or this
 * harness itself with a fresh context.
 */
import type { Message, StreamResponse } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import { messageText } from '../../app/api-server/convert.ts';
import type { TaskModelRequest } from '../../app/api-server/extensions/index.ts';
import { EXT } from '../../app/api-server/extensions/index.ts';
import type { Json } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import { sanitizeDescription } from '../core/context/builder.ts';
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

/** Folds one stream event into the outcome. */
function fold(outcome: Outcome, event: StreamResponse): void {
  const { payload } = event;
  if (payload?.$case === 'task') {
    outcome.subTask = { taskId: payload.value.id, contextId: payload.value.contextId };
    outcome.state = payload.value.status?.state ?? outcome.state;
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

function toResult(outcome: Outcome): ToolResult {
  const produced = [...outcome.artifacts.values()].filter((text) => text !== '').join('\n\n');
  const text = produced === '' ? outcome.statusText || outcome.reply : produced;
  if (outcome.state === TaskState.TASK_STATE_INPUT_REQUIRED && outcome.subTask !== null) {
    const { taskId } = outcome.subTask;
    return textResult(t('agent.invoke.needs-input', { question: outcome.statusText, taskId }));
  }
  const ended = ENDED[outcome.state];
  return ended === undefined
    ? textResult(text)
    : errorResult(ended, t('agent.invoke.ended', { state: ended, text }));
}

function agentsList(registry: EntityRegistry): string {
  const lines = registry.list('agent').map((agent: Agent) => {
    const skills = agent.skills.map((skill) => skill.name).join(', ');
    const about = sanitizeDescription(`${agent.name}: ${agent.description}`);
    return `- ${agent.ref.id} — ${about}${skills === '' ? '' : ` (skills: ${sanitizeDescription(skills)})`}`;
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
async function link(deps: InvokeAgentDeps, ctx: ToolCallContext, ref: TaskRef): Promise<void> {
  const parent = await deps.tasks.load(ctx.taskId);
  if (!parent.model.subTasks.some((known) => known.taskId === ref.taskId)) {
    const subTasks = [...parent.model.subTasks, ref];
    await deps.tasks.setModel(ctx.taskId, ctx.key, { ...parent.model, subTasks });
  }
}

async function call(
  deps: InvokeAgentDeps,
  agent: Agent,
  args: Json,
  ctx: ToolCallContext,
): Promise<ToolResult> {
  const parent = await deps.tasks.load(ctx.taskId);
  const continued = field(args, 'taskId');
  const lineage: TaskModelRequest = {
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
        content: { $case: 'text', value: field(args, 'message') },
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
  let linked = false;
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
  return toResult(outcome);
}

/** Builds the `invoke_agent` tool. Its description lists the agents registered right now. */
export function createInvokeAgentTool(deps: InvokeAgentDeps): Tool {
  return {
    ref: { kind: 'tool', id: INVOKE_AGENT, version: null },
    locality: { type: 'local' },
    get description(): string {
      return `${t('agent.invoke.description')}\n\n${agentsList(deps.registry)}`;
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
    invoke: async (args: Json, ctx: ToolCallContext): Promise<ToolResult> => {
      const id = field(args, 'agent');
      const ref = { kind: 'agent', id, version: null } as const;
      if (!deps.registry.has(ref)) {
        const available = deps.registry
          .list('agent')
          .map((agent: Agent) => agent.ref.id)
          .join(', ');
        return errorResult('not-found', t('agent.invoke.unknown', { agent: id, available }));
      }
      const { model } = await deps.tasks.load(ctx.taskId);
      if (model.depth + 1 > deps.maxDepth) {
        const message = t('agent.invoke.depth', { depth: model.depth, limit: deps.maxDepth });
        return errorResult('depth-limit', message);
      }
      try {
        const result = await call(deps, deps.registry.resolve(ref), args, ctx);
        return result;
      } catch (error) {
        return errorResult('unavailable', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
