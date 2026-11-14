/**
 * The two tools through which the model reaches a participant of its task:
 * `message_participant` for a quick input, `create_task_for_participant` for work they
 * must do (R12.2). Both go through the task's channel.
 */
import type { Message } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';

import type { Json } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import { t } from '../../kernel/strings.ts';
import type { AskRoute } from '../core/ask-routes.ts';
import type { Participant, StepKey, TaskId, ToolCall, ToolResult } from '../core/types.ts';
import type { Tool, ToolCallContext } from '../tools/types.ts';
import { defineTool, errorResult } from '../tools/types.ts';
import type { ChannelManager } from './manager.ts';
import type { Channel } from './types.ts';

/** The name of the tool that asks a participant a quick question. */
export const MESSAGE_PARTICIPANT = 'message_participant';
/** The name of the tool that hands a participant work of their own. */
export const CREATE_TASK_FOR_PARTICIPANT = 'create_task_for_participant';

const NAME_LENGTH = 60;

function field(args: Json, name: string): string {
  const value = isJsonObject(args) ? args[name] : undefined;
  return typeof value === 'string' ? value : '';
}

function strings(args: Json, name: string): string[] {
  const value = isJsonObject(args) ? args[name] : undefined;
  return Array.isArray(value) ? value.filter((entry: Json) => typeof entry === 'string') : [];
}

function outgoing(key: StepKey, text: string): Message {
  return {
    messageId: key,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function isOn(channel: Channel, id: string): boolean {
  return channel.participants.some((participant: Participant) => participant.id === id);
}

/** The error for a participant id that is not on the channel: it names who is. */
function unknownParticipant(channel: Channel, to: string): ToolResult {
  const participants = channel.participants
    .map(
      (participant: Participant) => `${participant.id} (${participant.kind}, ${participant.role})`,
    )
    .join(', ');
  return errorResult(
    'not-found',
    t('channel.tool.unknown-participant', { participant: to, participants }),
  );
}

/**
 * Builds `message_participant`. A question to a participant reached on the task's own
 * conversation never runs this tool: the ask route below claims the call and the loop
 * suspends on it. What runs here is a question to a participant reached directly.
 */
export function createMessageParticipantTool(channels: ChannelManager): Tool {
  return defineTool({
    id: MESSAGE_PARTICIPANT,
    description: t('channel.tool.message.description'),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        taskId: { type: 'string' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    invoke: async (args: Json, ctx: ToolCallContext): Promise<ToolResult> => {
      const to = field(args, 'to');
      const channel = await channels.forTask(ctx.taskId);
      if (!isOn(channel, to)) {
        return unknownParticipant(channel, to);
      }
      const reply = await channel.send(to, outgoing(ctx.key, field(args, 'message')), {
        key: ctx.key,
        signal: ctx.signal,
        continues: field(args, 'taskId'),
      });
      return reply.route === 'direct'
        ? reply.result
        : errorResult('unavailable', t('channel.tool.message.conversation', { participant: to }));
    },
  });
}

/**
 * Builds `create_task_for_participant`. For a participant reached directly — an agent —
 * the work becomes a task of theirs, recorded among this task's sub-tasks. A participant
 * reached only on the task's own conversation cannot be given a task of their own: the
 * call is refused and the model is pointed at `message_participant`.
 */
export function createTaskForParticipantTool(channels: ChannelManager): Tool {
  return defineTool({
    id: CREATE_TASK_FOR_PARTICIPANT,
    description: t('channel.tool.task.description'),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'string' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    invoke: async (args: Json, ctx: ToolCallContext): Promise<ToolResult> => {
      const to = field(args, 'to');
      const message = field(args, 'message');
      const channel = await channels.forTask(ctx.taskId);
      if (!isOn(channel, to)) {
        return unknownParticipant(channel, to);
      }
      if (channel.routeOf(to) === 'conversation') {
        return errorResult('unsupported', t('channel.tool.task.conversation', { participant: to }));
      }
      const reply = await channel.send(to, outgoing(ctx.key, message), {
        key: ctx.key,
        signal: ctx.signal,
        continues: field(args, 'taskId'),
        work: {
          name: field(args, 'name') === '' ? message.slice(0, NAME_LENGTH) : field(args, 'name'),
          goal: message,
          acceptanceCriteria: strings(args, 'acceptanceCriteria'),
        },
      });
      return reply.route === 'direct'
        ? reply.result
        : errorResult('unsupported', t('channel.tool.task.conversation', { participant: to }));
    },
  });
}

/**
 * The ask route of `message_participant`: a question to a participant who is reached on
 * the task's own conversation is put there by the core loop, exactly as `ask_user` is.
 * When several users are on the task, the question says whom it is for.
 */
export function createAskRoute(channels: ChannelManager): AskRoute {
  return async (taskId: TaskId, call: ToolCall): Promise<string | null> => {
    const to = field(call.args, 'to');
    const message = field(call.args, 'message');
    if (call.name !== MESSAGE_PARTICIPANT || to === '' || message === '') {
      return null;
    }
    const channel = await channels.forTask(taskId);
    const addressed = channel.participants.find(
      (participant: Participant) => participant.id === to,
    );
    if (addressed === undefined || channel.routeOf(to) !== 'conversation') {
      return null;
    }
    const users = channel.participants.filter(
      (participant: Participant) => participant.kind === 'user',
    );
    return users.length > 1
      ? t('channel.tool.message.addressed', {
          participant: addressed.displayName ?? addressed.id,
          message,
        })
      : message;
  };
}
