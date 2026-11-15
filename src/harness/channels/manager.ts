/**
 * The channel manager: the harness's own hand on channels. It finds the channel a message
 * belongs to, it is the only thing that changes who is on one, and it is the door every
 * inbound message passes.
 */
import type { Message } from '@a2a-js/sdk';

import type { InvokeAgentDeps } from '../a2a/invoke-tool.ts';
import type { TaskSnapshot } from '../core/task-port.ts';
import type { Participant, TaskId } from '../core/types.ts';
import { createDefaultChannel, defaultSender } from './default-channel.ts';
import type { Channel, ParticipantId } from './types.ts';
import { ChannelNotFoundError, NotAParticipantError, ParticipantConflictError } from './types.ts';

/** What the manager works with: the registry, the tasks, and the delegation depth limit. */
export type ChannelManagerDeps = InvokeAgentDeps;

/**
 * Finds channels and governs their membership.
 *
 * Invariants:
 * - The id of a task's default channel is the task's id. A `channel` entity registered
 *   under an id is found before a task's default channel of the same id.
 * - The participants of a default channel are the task model's `participants`, and
 *   {@link ChannelManager.addParticipant} and {@link ChannelManager.removeParticipant}
 *   are the only operations that change them after the task is created (R12.4).
 * - No message is admitted to a channel from someone who is not on it (R12.5).
 *
 * Provided to plugins as the cordis service `ctx.channels`.
 */
export class ChannelManager {
  readonly #deps: ChannelManagerDeps;
  #changes = 0;

  constructor(deps: ChannelManagerDeps) {
    this.#deps = deps;
  }

  /** Whether a `channel` entity — a channel that is not a task's default — has this id. */
  isRegistered(channelId: string): boolean {
    return this.#deps.registry.has({ kind: 'channel', id: channelId, version: null });
  }

  /**
   * The default channel of a task, built from the task model's participants as they are
   * now.
   *
   * @throws ChannelNotFoundError when there is no such task.
   */
  async forTask(taskId: TaskId): Promise<Channel> {
    return createDefaultChannel(this.#deps, await this.#task(taskId));
  }

  /**
   * The channel with this id: a registered `channel` entity, else the default channel of
   * the task with this id.
   *
   * @throws ChannelNotFoundError when neither exists.
   */
  get(channelId: string): Promise<Channel> {
    return this.isRegistered(channelId)
      ? Promise.resolve(
          this.#deps.registry.resolve({ kind: 'channel', id: channelId, version: null }),
        )
      : this.forTask(channelId);
  }

  /**
   * Puts `participant` on the default channel of the task `channelId`.
   *
   * @throws ChannelNotFoundError when there is no such task.
   * @throws ParticipantConflictError when someone with that id is already on it.
   */
  async addParticipant(channelId: string, participant: Participant): Promise<void> {
    const task = await this.#task(channelId);
    const added = await this.#change(task, (participants) =>
      participants.some((known: Participant) => known.id === participant.id)
        ? null
        : [...participants, participant],
    );
    if (!added) {
      throw new ParticipantConflictError(channelId, participant.id);
    }
  }

  /**
   * Takes the participant `participantId` off the default channel of the task `channelId`.
   *
   * @throws ChannelNotFoundError when there is no such task.
   * @throws NotAParticipantError when nobody with that id is on it.
   */
  async removeParticipant(channelId: string, participantId: ParticipantId): Promise<void> {
    const task = await this.#task(channelId);
    const removed = await this.#change(task, (participants) => {
      const kept = participants.filter((known: Participant) => known.id !== participantId);
      return kept.length === participants.length ? null : kept;
    });
    if (!removed) {
      throw new NotAParticipantError(channelId, participantId);
    }
  }

  /**
   * The inbound door: looks the channel up and admits `message` from `from`.
   *
   * `from` is null when the sender declared nobody. The message is then taken to come
   * from the channel's default sender (see {@link defaultSender}) — there is no
   * authentication yet, so a declared id is trusted as it stands and an undeclared one
   * is the task's own user.
   *
   * @throws ChannelNotFoundError when there is no such channel.
   * @throws NotAParticipantError unless the sender is one of the channel's participants
   *   (R12.5).
   */
  async receive(channelId: string, from: ParticipantId | null, message: Message): Promise<void> {
    const channel = await this.get(channelId);
    const sender = from ?? defaultSender(channel.participants)?.id;
    if (sender === undefined) {
      throw new NotAParticipantError(channelId, '');
    }
    await channel.receive(sender, message);
  }

  async #task(taskId: TaskId): Promise<TaskSnapshot> {
    try {
      return await this.#deps.tasks.load(taskId);
    } catch (error) {
      throw new ChannelNotFoundError(taskId, error);
    }
  }

  /**
   * Changes the participants in one store update, so two changes made at once both
   * count: `change` sees the list as it is at that moment, and returns the new list or
   * null to change nothing. Resolves with whether it changed anything.
   */
  async #change(
    task: TaskSnapshot,
    change: (participants: readonly Participant[]) => readonly Participant[] | null,
  ): Promise<boolean> {
    this.#changes += 1;
    // Not a step of the task's run: each change is its own write, never a repeat of another.
    const key = `${task.taskId}/-/channels/${String(this.#changes)}-${String(Date.now())}`;
    let changed = false;
    await this.#deps.tasks.setModel(task.taskId, key, (current) => {
      const next = change(current.participants);
      changed = next !== null;
      return next === null ? current : { ...current, participants: next };
    });
    return changed;
  }
}
