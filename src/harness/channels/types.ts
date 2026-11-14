/**
 * Channels as entities. A channel is the set of participants of one conversation and the
 * way a message travels to and from each of them. Who is on a channel, and in which role,
 * is the task model's `participants` — a channel adds the transport, not another list.
 */
import type { Message } from '@a2a-js/sdk';

import type { Entity } from '../../kernel/entity.ts';
import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { TaskModelRequest } from '../../app/api-server/extensions/index.ts';
import type { Participant, StepKey, ToolResult } from '../core/types.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    channel: Channel;
  }
}

/** The id of a participant: {@link Participant.id}. */
export type ParticipantId = Participant['id'];

/**
 * How a message to a participant travels.
 *
 * - `conversation` — it is asked on the task's own conversation: the task rests in
 *   `input-required` and the next message on the task is the reply. The core loop does
 *   this; {@link Channel.send} does not.
 * - `direct` — {@link Channel.send} delivers it and returns the reply.
 */
export type ChannelRoute = 'conversation' | 'direct';

/** What one {@link Channel.send} is told besides the message. */
export interface ChannelSendOptions {
  /** The step sending the message; writes made on its behalf are keyed with it. */
  readonly key: StepKey;
  /** Aborted when the sender's turn is interrupted or its task cancelled. */
  readonly signal: AbortSignal;
  /**
   * Present when the message hands the participant work of their own: what their task is
   * called and when it is done. Absent for a quick question.
   */
  readonly work?:
    | Pick<TaskModelRequest, 'name' | 'goal' | 'description' | 'acceptanceCriteria'>
    | undefined;
  /** The participant's task this message continues, when it answers a question of theirs. */
  readonly continues?: string | undefined;
}

/** What came of sending a message. */
export type ChannelReply =
  /** The participant answered, or could not be reached: either way, here is the result. */
  | { readonly route: 'direct'; readonly result: ToolResult }
  /** The message belongs on the task's own conversation; nothing was sent. */
  | { readonly route: 'conversation' };

/**
 * A channel: participants, and a way to and from each.
 *
 * Invariant: `participants` changes only through the harness's `ChannelManager`. Nothing
 * a participant sends adds or removes one.
 */
export interface Channel extends Entity<'channel'> {
  readonly participants: readonly Participant[];
  /**
   * How a message to `to` travels.
   *
   * @throws NotAParticipantError when `to` is not in `participants`.
   */
  routeOf(to: ParticipantId): ChannelRoute;
  /**
   * Sends `message` to the participant `to`. A participant that cannot be reached, or
   * whose task ended badly, is reported in the reply, not thrown.
   *
   * @throws NotAParticipantError when `to` is not in `participants`.
   */
  send(to: ParticipantId, message: Message, options: ChannelSendOptions): Promise<ChannelReply>;
  /**
   * Admits `message` from the participant `from` to the conversation. It resolves when
   * the message may go on to the inbox.
   *
   * @throws NotAParticipantError when `from` is not in `participants` (R12.5).
   */
  receive(from: ParticipantId, message: Message): Promise<void>;
}

/**
 * Someone who is not on a channel tried to use it, or was addressed on it. An empty
 * `participantId` means the sender declared nobody and the channel has no participant a
 * message could be attributed to. The message never lists who is on the channel: it is
 * shown to the one who was turned away.
 */
export class NotAParticipantError extends YaahError {
  readonly channelId: string;
  readonly participantId: string;

  constructor(channelId: string, participantId: string) {
    super(
      'channel.not-a-participant',
      t(participantId === '' ? 'error.channel.undeclared' : 'error.channel.not-a-participant', {
        channel: channelId,
        participant: participantId,
      }),
    );
    this.channelId = channelId;
    this.participantId = participantId;
  }
}

/** No channel has this id: no entity is registered under it and no task owns it. */
export class ChannelNotFoundError extends YaahError {
  readonly channelId: string;

  constructor(channelId: string, cause?: unknown) {
    super('channel.not-found', t('error.channel.not-found', { channel: channelId }), cause);
    this.channelId = channelId;
  }
}

/** A participant with this id is already on the channel. */
export class ParticipantConflictError extends YaahError {
  constructor(channelId: string, participantId: string) {
    super(
      'channel.participant-conflict',
      t('error.channel.participant-conflict', { channel: channelId, participant: participantId }),
    );
  }
}
