import { describe, expect, test } from 'bun:test';
import type { Message } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';

import { PARTICIPANTS, channelFixture } from '../../../test/support/channels.ts';
import type { Channel } from '../../harness/channels/types.ts';
import { ChannelNotFoundError, NotAParticipantError } from '../../harness/channels/types.ts';
import { AdmissionGate } from '../api-server/admission.ts';
import { EXT, InvalidExtensionError } from '../api-server/extensions/index.ts';
import { createChannelAdmission } from './inbound.ts';

function message(taskId: string, metadata?: Record<string, unknown>): Message {
  return {
    messageId: 'm1',
    contextId: '',
    taskId,
    role: Role.ROLE_USER,
    parts: [],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

function from(id: string, channel?: string): Record<string, unknown> {
  return { [EXT.channels]: channel === undefined ? { from: id } : { from: id, channel } };
}

/** A registered channel that is not a task, with these members. */
function room(members: readonly string[]): Channel {
  return {
    ref: { kind: 'channel', id: 'ops-room', version: null },
    description: 'A channel that is not a task.',
    locality: { type: 'local' },
    participants: members.map((id: string) => ({ id, role: 'admin', kind: 'user' })),
    routeOf: () => 'direct',
    send: () => Promise.resolve({ route: 'conversation' }),
    receive: (sender: string) =>
      members.includes(sender)
        ? Promise.resolve()
        : Promise.reject(new NotAParticipantError('ops-room', sender)),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the admission check of the channels API', () => {
  test('admits a participant of the task, declared or not', async () => {
    const admit = createChannelAdmission(channelFixture().channels);
    expect(await rejection(admit(message('t1', from('ada'))))).toBeUndefined();
    expect(await rejection(admit(message('t1', from('ada', 't1'))))).toBeUndefined();
    expect(await rejection(admit(message('t1')))).toBeUndefined();
  });

  test('refuses someone who is not on the task', async () => {
    const admit = createChannelAdmission(channelFixture().channels);
    const error = await rejection(admit(message('t1', from('mallory'))));
    expect(error).toBeInstanceOf(NotAParticipantError);
    expect(error instanceof NotAParticipantError ? error.channelId : '').toBe('t1');
  });

  test('does not let membership of one task open another', async () => {
    const fixture = channelFixture();
    fixture.tasks.create({
      taskId: 't2',
      model: { participants: [{ id: 'mallory', role: 'reporter', kind: 'user' }] },
    });
    const admit = createChannelAdmission(fixture.channels);
    expect(await rejection(admit(message('t1', from('mallory', 't2'))))).toBeInstanceOf(
      ChannelNotFoundError,
    );
    expect(await rejection(admit(message('', from('mallory', 't2'))))).toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  test('checks a registered channel against its own participants', async () => {
    const grace = { id: 'grace', role: 'admin', kind: 'user' } as const;
    const fixture = channelFixture([...PARTICIPANTS, grace]);
    fixture.registry.register(room(['grace']));
    const admit = createChannelAdmission(fixture.channels);
    expect(await rejection(admit(message('t1', from('grace', 'ops-room'))))).toBeUndefined();
    expect(await rejection(admit(message('t1', from('ada', 'ops-room'))))).toBeInstanceOf(
      NotAParticipantError,
    );
  });

  test('does not let a registered channel open a task its sender is not on', async () => {
    const fixture = channelFixture();
    fixture.registry.register(room(['mallory']));
    const admit = createChannelAdmission(fixture.channels);
    const error = await rejection(admit(message('t1', from('mallory', 'ops-room'))));
    expect(error).toBeInstanceOf(NotAParticipantError);
    expect(error instanceof NotAParticipantError ? error.channelId : '').toBe('t1');
    expect(await rejection(admit(message('gone', from('mallory', 'ops-room'))))).toBeUndefined();
  });

  test('lets a message for a task that does not exist through to the A2A layer', async () => {
    const admit = createChannelAdmission(channelFixture().channels);
    expect(await rejection(admit(message('gone', from('ada'))))).toBeUndefined();
  });

  test('admits the message that creates a task unless it contradicts itself', async () => {
    const admit = createChannelAdmission(channelFixture().channels);
    const participants = [{ id: 'ada', role: 'reporter', kind: 'user' }];
    expect(await rejection(admit(message('')))).toBeUndefined();
    expect(await rejection(admit(message('', from('bob'))))).toBeUndefined();
    expect(
      await rejection(admit(message('', { ...from('ada'), [EXT.taskModel]: { participants } }))),
    ).toBeUndefined();
    expect(
      await rejection(admit(message('', { ...from('bob'), [EXT.taskModel]: { participants } }))),
    ).toBeInstanceOf(NotAParticipantError);
  });

  test('refuses malformed extension data', async () => {
    const admit = createChannelAdmission(channelFixture().channels);
    const error = await rejection(admit(message('t1', { [EXT.channels]: { from: '' } })));
    expect(error).toBeInstanceOf(InvalidExtensionError);
  });
});

describe('AdmissionGate', () => {
  test('answers a refusal with an A2A error that carries its message and code', async () => {
    const gate = new AdmissionGate();
    gate.add(createChannelAdmission(channelFixture().channels));
    const error = await rejection(gate.check(message('t1', from('mallory'))));
    expect(error).toBeInstanceOf(RequestMalformedError);
    expect(error instanceof RequestMalformedError ? error.message : '').toBe(
      '"mallory" is not a participant of channel "t1".',
    );
    expect(error instanceof RequestMalformedError ? error.metadata : {}).toEqual({
      code: 'channel.not-a-participant',
    });
  });

  test('runs every check, passes other failures on, and forgets a removed check', async () => {
    const gate = new AdmissionGate();
    const seen: string[] = [];
    const remove = gate.add((incoming: Message) => {
      seen.push(incoming.messageId);
      return Promise.resolve();
    });
    const broken = new Error('store down');
    const removeBroken = gate.add(() => Promise.reject(broken));
    expect(await rejection(gate.check(message('t1')))).toBe(broken);
    removeBroken();
    await gate.check(message('t1'));
    await gate.check(undefined);
    remove();
    await gate.check(message('t1'));
    expect(seen).toEqual(['m1', 'm1']);
  });
});
