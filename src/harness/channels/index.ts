/**
 * The channels plugin: the `channel` entity kind, the channel manager, and the two tools
 * through which the model reaches a participant of its task. Provides the `channels`
 * service.
 */
import type { Context } from 'cordis';

import { registerEntity } from '../../kernel/registry.ts';
import { ChannelManager } from './manager.ts';
import {
  createAskRoute,
  createMessageParticipantTool,
  createTaskForParticipantTool,
} from './tools.ts';

export { createDefaultChannel, defaultSender } from './default-channel.ts';
export { ChannelManager } from './manager.ts';
export type { ChannelManagerDeps } from './manager.ts';
export {
  CREATE_TASK_FOR_PARTICIPANT,
  MESSAGE_PARTICIPANT,
  createAskRoute,
  createMessageParticipantTool,
  createTaskForParticipantTool,
} from './tools.ts';
export { ChannelNotFoundError, NotAParticipantError, ParticipantConflictError } from './types.ts';
export type {
  Channel,
  ChannelReply,
  ChannelRoute,
  ChannelSendOptions,
  ParticipantId,
} from './types.ts';

declare module 'cordis' {
  interface Context {
    /** The channels of this harness, and the only way to change who is on one. */
    channels: ChannelManager;
  }
}

export const name = 'channels';
export const inject: readonly string[] = ['entities', 'config', 'taskRuntime'];

/** Starts the channels plugin. */
export function apply(ctx: Context): void {
  const manager = new ChannelManager({
    registry: ctx.entities,
    tasks: ctx.taskRuntime.tasks,
    maxDepth: ctx.config.limits.maxAgentDepth,
  });
  ctx.provide('channels', manager);
  registerEntity(ctx, createMessageParticipantTool(manager));
  registerEntity(ctx, createTaskForParticipantTool(manager));
  ctx.effect(() => ctx.taskRuntime.addAskRoute(createAskRoute(manager)));
}
