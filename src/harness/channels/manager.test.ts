import { describe, expect, test } from 'bun:test';
import type { Message } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';

import {
  PARTICIPANTS,
  channelFixture,
  fakeAgent,
  resultText,
  sentText,
} from '../../../test/support/channels.ts';
import { EXT } from '../../app/api-server/extensions/index.ts';
import { defaultSender } from './default-channel.ts';
import type { Channel } from './types.ts';
import { ChannelNotFoundError, NotAParticipantError, ParticipantConflictError } from './types.ts';

function message(text: string): Message {
  return {
    messageId: 'm1',
    contextId: '',
    taskId: 't1',
    role: Role.ROLE_USER,
    parts: [
      { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

const options = { key: 't1/4/tool.invoke/c1', signal: new AbortController().signal };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the default channel of a task', () => {
  test('has the participants of the task model and the task id as its id', async () => {
    const { channels } = channelFixture();
    const channel = await channels.forTask('t1');
    expect(channel.ref).toEqual({ kind: 'channel', id: 't1', version: null });
    expect(channel.participants).toEqual(PARTICIPANTS);
    expect(channel.locality).toEqual({ type: 'local' });
    expect(channel.description).toContain('default channel');
  });

  test('reaches a user on the conversation and an agent directly', async () => {
    const { channels } = channelFixture();
    const channel = await channels.forTask('t1');
    expect(channel.routeOf('ada')).toBe('conversation');
    expect(channel.routeOf('billing')).toBe('direct');
    expect(() => channel.routeOf('mallory')).toThrow(NotAParticipantError);
  });

  test('sends nothing for a user: the question belongs on the conversation', async () => {
    const { channels } = channelFixture();
    const channel = await channels.forTask('t1');
    expect(await channel.send('ada', message('Which order?'), options)).toEqual({
      route: 'conversation',
    });
  });

  test('asks an agent over its agent entity and returns the reply, untracked', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent('billing', () => 'Paid on Monday.');
    fixture.registry.register(billing.agent);
    const channel = await fixture.channels.forTask('t1');
    const reply = await channel.send('billing', message('Is invoice 7 paid?'), options);
    expect(reply.route === 'direct' ? resultText(reply.result) : '').toBe('Paid on Monday.');
    expect(sentText(billing.received[0])).toBe('Is invoice 7 paid?');
    expect(billing.received[0]?.metadata?.[EXT.taskModel]).toEqual({
      parentTasks: [{ taskId: 't1', contextId: 'ctx-t1', agent: 'self' }],
      depth: 1,
    });
    expect((await fixture.tasks.load('t1')).model.subTasks).toEqual([]);
  });

  test('hands an agent work as a tracked sub-task that carries the task model', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent('billing', () => 'Refund issued.');
    fixture.registry.register(billing.agent);
    const channel = await fixture.channels.forTask('t1');
    const work = { name: 'Refund', goal: 'Refund order A-1', acceptanceCriteria: ['Money back'] };
    const reply = await channel.send('billing', message('Refund order A-1'), { ...options, work });
    expect(reply.route === 'direct' ? resultText(reply.result) : '').toBe('Refund issued.');
    expect(billing.received[0]?.metadata?.[EXT.taskModel]).toEqual({
      ...work,
      parentTasks: [{ taskId: 't1', contextId: 'ctx-t1', agent: 'self' }],
      depth: 1,
    });
    expect((await fixture.tasks.load('t1')).model.subTasks).toEqual([
      { taskId: 'billing-task', contextId: 'billing-context', agent: 'billing' },
    ]);
  });

  test('reports an agent participant with no agent entity as a result', async () => {
    const { channels } = channelFixture();
    const channel = await channels.forTask('t1');
    const reply = await channel.send('billing', message('Hello?'), options);
    expect(reply.route === 'direct' ? resultText(reply.result) : '').toContain('error not-found');
  });

  test('refuses to send to someone who is not on it', async () => {
    const { channels } = channelFixture();
    const channel = await channels.forTask('t1');
    const error = await rejection(channel.send('mallory', message('Hi'), options));
    expect(error).toBeInstanceOf(NotAParticipantError);
  });

  test('names the default sender: the reporting user, else a user, else the reporter', () => {
    expect(defaultSender(PARTICIPANTS)?.id).toBe('ada');
    expect(
      defaultSender([
        { id: 'w', role: 'watcher', kind: 'user' },
        { id: 'a', role: 'reporter', kind: 'agent' },
      ])?.id,
    ).toBe('w');
    expect(defaultSender([{ id: 'a', role: 'reporter', kind: 'agent' }])?.id).toBe('a');
    expect(defaultSender([{ id: 'self', role: 'assignee', kind: 'agent' }])).toBeNull();
  });
});

describe('ChannelManager', () => {
  test('does not know a channel that is neither registered nor a task', async () => {
    const { channels } = channelFixture();
    const error = await rejection(channels.get('nope'));
    expect(error).toBeInstanceOf(ChannelNotFoundError);
    expect(error instanceof ChannelNotFoundError ? error.channelId : '').toBe('nope');
    expect(await rejection(channels.receive('nope', 'ada', message('Hi')))).toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  test('receives from a participant and rejects anyone else', async () => {
    const { channels } = channelFixture();
    expect(await rejection(channels.receive('t1', 'ada', message('Hi')))).toBeUndefined();
    const error = await rejection(channels.receive('t1', 'mallory', message('Hi')));
    expect(error).toBeInstanceOf(NotAParticipantError);
    expect(error instanceof NotAParticipantError ? error.participantId : '').toBe('mallory');
    expect(error instanceof NotAParticipantError ? error.message : '').not.toContain('ada');
  });

  test('takes an undeclared sender to be the default one, when there is one', async () => {
    const { channels } = channelFixture();
    expect(await rejection(channels.receive('t1', null, message('Hi')))).toBeUndefined();
    const lonely = channelFixture([{ id: 'self', role: 'assignee', kind: 'agent' }]);
    const error = await rejection(lonely.channels.receive('t1', null, message('Hi')));
    expect(error).toBeInstanceOf(NotAParticipantError);
    expect(error instanceof NotAParticipantError ? error.message : '').toContain('no sender');
  });

  test('adds a participant, who can then be received from', async () => {
    const { channels, tasks } = channelFixture();
    const grace = { id: 'grace', role: 'watcher', kind: 'user' } as const;
    expect(await rejection(channels.receive('t1', 'grace', message('Hi')))).toBeInstanceOf(
      NotAParticipantError,
    );
    await channels.addParticipant('t1', grace);
    expect((await tasks.load('t1')).model.participants).toEqual([...PARTICIPANTS, grace]);
    expect(await rejection(channels.receive('t1', 'grace', message('Hi')))).toBeUndefined();
    expect(await rejection(channels.addParticipant('t1', grace))).toBeInstanceOf(
      ParticipantConflictError,
    );
  });

  test('removes a participant, who is rejected from then on', async () => {
    const { channels } = channelFixture();
    await channels.removeParticipant('t1', 'ada');
    expect(await rejection(channels.receive('t1', 'ada', message('Hi')))).toBeInstanceOf(
      NotAParticipantError,
    );
    expect(await rejection(channels.removeParticipant('t1', 'ada'))).toBeInstanceOf(
      NotAParticipantError,
    );
    await channels.addParticipant('t1', { id: 'ada', role: 'admin', kind: 'user' });
    expect((await channels.forTask('t1')).participants.at(-1)?.role).toBe('admin');
  });

  test('changes membership only of a task that exists', async () => {
    const { channels } = channelFixture();
    const grace = { id: 'grace', role: 'watcher', kind: 'user' } as const;
    expect(await rejection(channels.addParticipant('nope', grace))).toBeInstanceOf(
      ChannelNotFoundError,
    );
    expect(await rejection(channels.removeParticipant('nope', 'ada'))).toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  test('finds a registered channel entity before a default channel', async () => {
    const { channels, registry } = channelFixture();
    const received: string[] = [];
    const custom: Channel = {
      ref: { kind: 'channel', id: 'ops-room', version: null },
      description: 'A channel that is not a task.',
      locality: { type: 'local' },
      participants: [{ id: 'grace', role: 'admin', kind: 'user' }],
      routeOf: () => 'direct',
      send: () => Promise.resolve({ route: 'conversation' }),
      receive: (from: string) => {
        received.push(from);
        return Promise.resolve();
      },
    };
    expect(channels.isRegistered('ops-room')).toBe(false);
    registry.register(custom);
    expect(channels.isRegistered('ops-room')).toBe(true);
    expect(await channels.get('ops-room')).toBe(custom);
    await channels.receive('ops-room', null, message('Hi'));
    expect(received).toEqual(['grace']);
  });
});
