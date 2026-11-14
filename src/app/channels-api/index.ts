/**
 * The channels-API plugin: declares the `channels` A2A extension in the agent card and
 * puts the channel manager in front of every incoming message, so that a message from
 * someone who is not on the channel is answered with an A2A error and goes no further.
 */
import type { Context } from 'cordis';

import { EXT } from '../api-server/extensions/index.ts';
import { createChannelAdmission } from './inbound.ts';

export { createChannelAdmission } from './inbound.ts';

export const name = 'channels-api';
export const inject: readonly string[] = ['a2a', 'channels', 'strings'];

/** Starts the channels API. */
export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.a2a.addExtension({
      uri: EXT.channels,
      description: ctx.strings.t('channel.extension.description'),
      required: false,
      params: undefined,
    }),
  );
  ctx.effect(() => ctx.a2a.addAdmission(createChannelAdmission(ctx.channels)));
}
