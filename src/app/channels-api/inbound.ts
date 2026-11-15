/**
 * The inbound path of the channels API: every message a caller sends is put to the
 * channel manager before the API server does anything with it.
 *
 * There is no authentication yet. The participant id a sender declares in the `channels`
 * extension is trusted as it stands, and a message that declares nothing is taken to
 * come from the task's default user participant. An authentication plugin will bind the
 * id to the authenticated caller; until then this check keeps honest senders apart, it
 * does not stop one who lies about who they are.
 */
import type { Message } from '@a2a-js/sdk';

import type { ChannelManager } from '../../harness/channels/manager.ts';
import { ChannelNotFoundError, NotAParticipantError } from '../../harness/channels/types.ts';
import type { Participant } from '../../harness/core/types.ts';
import { t } from '../../kernel/strings.ts';
import type { Admission } from '../api-server/admission.ts';
import { EXT, SCHEMAS, readExtension } from '../api-server/extensions/index.ts';

/**
 * A message that creates a task also creates its channel, so there is no membership to
 * check yet — except against itself: a sender who lists the participants and declares an
 * id that is not among them is refused.
 */
function admitCreation(message: Message, from: string | undefined): void {
  const wanted = readExtension(message.metadata, EXT.taskModel, SCHEMAS.taskModelRequest);
  const participants = wanted?.participants;
  if (
    from !== undefined &&
    participants !== undefined &&
    !participants.some((participant: Participant) => participant.id === from)
  ) {
    throw new NotAParticipantError(t('channel.new'), from);
  }
}

/**
 * Builds the admission check of the channels API.
 *
 * The channel a message arrives on is the one it declares, else the default channel of
 * its task. A declared channel must be that default channel or a registered `channel`
 * entity — never another task's channel, so being on one task opens no other. A sender
 * who declares a registered channel for a task must be on the task's own channel too.
 *
 * The check throws:
 * - `NotAParticipantError` when the sender is not a participant of the channel, or of the
 *   task the message is for (R12.5);
 * - `ChannelNotFoundError` when the declared channel does not exist;
 * - `InvalidExtensionError` when the extension data is malformed.
 *
 * A message for a task that does not exist is let through: the A2A layer answers it
 * with its own task-not-found error.
 */
export function createChannelAdmission(channels: ChannelManager): Admission {
  return async (message: Message): Promise<void> => {
    const declared = readExtension(message.metadata, EXT.channels, SCHEMAS.channelsMessage);
    const channelId = declared?.channel ?? message.taskId;
    if (channelId === '') {
      admitCreation(message, declared?.from);
      return;
    }
    const isOwn = channelId === message.taskId;
    if (!isOwn && !channels.isRegistered(channelId)) {
      throw new ChannelNotFoundError(channelId);
    }
    const from = declared?.from ?? null;
    if (isOwn) {
      await receiveOnOwn(channels, channelId, from, message);
      return;
    }
    await channels.receive(channelId, from, message);
    if (message.taskId !== '') {
      // The message is for a task too: its sender must be on that task's own channel.
      await receiveOnOwn(channels, message.taskId, from, message);
    }
  };
}

/** Puts a message to its task's own channel; a task that does not exist is the A2A layer's. */
async function receiveOnOwn(
  channels: ChannelManager,
  taskId: string,
  from: string | null,
  message: Message,
): Promise<void> {
  try {
    await channels.receive(taskId, from, message);
  } catch (error) {
    if (!(error instanceof ChannelNotFoundError)) {
      throw error;
    }
  }
}
