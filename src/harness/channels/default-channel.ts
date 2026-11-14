/**
 * The default channel of a task: its participants are the task model's, a user is
 * reached on the task's own conversation, and an agent is reached by an A2A call through
 * the `agent` entity registered under the participant's id.
 */
import type { Message } from '@a2a-js/sdk';

import { messageText } from '../../app/api-server/convert.ts';
import { LOCAL } from '../../kernel/entity.ts';
import { t } from '../../kernel/strings.ts';
import type { InvokeAgentDeps } from '../a2a/invoke-tool.ts';
import { delegate } from '../a2a/invoke-tool.ts';
import type { TaskSnapshot } from '../core/task-port.ts';
import type { Participant } from '../core/types.ts';
import type { Channel, ChannelReply, ChannelRoute, ChannelSendOptions } from './types.ts';
import { NotAParticipantError } from './types.ts';

/**
 * Who a message that declares no sender is taken to come from: the user who reported
 * the task, else any user on it, else whoever reported it. Null when the channel has
 * nobody a message could be attributed to.
 */
export function defaultSender(participants: readonly Participant[]): Participant | null {
  const users = participants.filter((participant: Participant) => participant.kind === 'user');
  const reported = (among: readonly Participant[]): Participant | undefined =>
    among.find((participant: Participant) => participant.role === 'reporter');
  return reported(users) ?? users[0] ?? reported(participants) ?? null;
}

/**
 * Builds the default channel of `task` — a view of the task as it is now. It holds no
 * state of its own: membership is the task model's `participants`, so a channel built
 * after a change shows the change, and nothing is lost on a restart.
 */
export function createDefaultChannel(deps: InvokeAgentDeps, task: TaskSnapshot): Channel {
  const { participants } = task.model;
  const member = (id: string): Participant => {
    const found = participants.find((participant: Participant) => participant.id === id);
    if (found === undefined) {
      throw new NotAParticipantError(task.taskId, id);
    }
    return found;
  };
  const routeOf = (to: string): ChannelRoute =>
    member(to).kind === 'user' ? 'conversation' : 'direct';
  return {
    ref: { kind: 'channel', id: task.taskId, version: null },
    description: t('channel.default.description'),
    locality: LOCAL,
    participants,
    routeOf,
    send: async (
      to: string,
      message: Message,
      options: ChannelSendOptions,
    ): Promise<ChannelReply> => {
      if (routeOf(to) === 'conversation') {
        return { route: 'conversation' };
      }
      const result = await delegate(
        deps,
        to,
        {
          message: messageText(message),
          taskId: options.continues ?? '',
          // Work is a task of the participant's that this task answers for; a question is not.
          track: options.work !== undefined,
          task: options.work,
          needsInput: (question: string, taskId: string): string =>
            t('channel.needs-input', { participant: to, question, taskId }),
        },
        { taskId: task.taskId, key: options.key, signal: options.signal },
      );
      return { route: 'direct', result };
    },
    receive: (from: string): Promise<void> =>
      new Promise<void>((resolve: () => void) => {
        member(from);
        resolve();
      }),
  };
}
