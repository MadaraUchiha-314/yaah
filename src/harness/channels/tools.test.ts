import { describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import {
  PARTICIPANTS,
  channelFixture,
  fakeAgent,
  resultText,
  sentText,
} from '../../../test/support/channels.ts';
import { EXT } from '../../app/api-server/extensions/index.ts';
import type { Json } from '../../kernel/json.ts';
import {
  CREATE_TASK_FOR_PARTICIPANT,
  MESSAGE_PARTICIPANT,
  createAskRoute,
  createMessageParticipantTool,
  createTaskForParticipantTool,
} from './tools.ts';

describe('message_participant', () => {
  test('tells the two tools apart in its description', () => {
    const { channels } = channelFixture();
    const tool = createMessageParticipantTool(channels);
    expect(tool.ref.id).toBe(MESSAGE_PARTICIPANT);
    expect(tool.description).toContain('quick input');
    expect(tool.description).toContain(CREATE_TASK_FOR_PARTICIPANT);
    expect(tool.retrySafe).toBe(false);
  });

  test('returns an agent participant’s reply and tracks no sub-task', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent('billing', () => 'Paid on Monday.');
    fixture.registry.register(billing.agent);
    const tool = createMessageParticipantTool(fixture.channels);
    const result = await tool.invoke({ to: 'billing', message: 'Is 7 paid?' }, fixture.call(1));
    expect(resultText(result)).toBe('Paid on Monday.');
    expect(sentText(billing.received[0])).toBe('Is 7 paid?');
    expect((await fixture.tasks.load('t1')).model.subTasks).toEqual([]);
  });

  test('passes on a question the agent asks back, and continues its task', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent(
      'billing',
      () => 'Which invoice?',
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    fixture.registry.register(billing.agent);
    const tool = createMessageParticipantTool(fixture.channels);
    const asked = await tool.invoke({ to: 'billing', message: 'Is it paid?' }, fixture.call(1));
    expect(resultText(asked)).toContain('Which invoice?');
    expect(resultText(asked)).toContain('taskId "billing-task"');
    expect(resultText(asked)).not.toContain('invoke_agent');
    await tool.invoke(
      { to: 'billing', message: 'Invoice 7', taskId: 'billing-task' },
      fixture.call(2),
    );
    expect(billing.received[1]?.taskId).toBe('billing-task');
    expect(billing.received[1]?.metadata).toBeUndefined();
  });

  test('names the participants when the id is unknown', async () => {
    const { channels, call } = channelFixture();
    const tool = createMessageParticipantTool(channels);
    const result = await tool.invoke({ to: 'bob', message: 'Hi' }, call(1));
    expect(resultText(result)).toContain('error not-found');
    expect(resultText(result)).toContain('ada (user, reporter)');
    expect(resultText(result)).toContain('billing (agent, watcher)');
  });

  test('refuses at the delegation depth limit', async () => {
    const fixture = channelFixture(PARTICIPANTS, { depth: 3, maxDepth: 3 });
    fixture.registry.register(fakeAgent('billing', () => 'never').agent);
    const tool = createMessageParticipantTool(fixture.channels);
    const result = await tool.invoke({ to: 'billing', message: 'Hi' }, fixture.call(1));
    expect(resultText(result)).toContain('error depth-limit');
  });

  test('points at ask_user when it is run for a participant on the conversation', async () => {
    const { channels, call } = channelFixture();
    const tool = createMessageParticipantTool(channels);
    const result = await tool.invoke({ to: 'ada', message: 'Which order?' }, call(1));
    expect(resultText(result)).toContain('error unavailable');
    expect(resultText(result)).toContain('ask_user');
  });
});

describe('create_task_for_participant', () => {
  test('tells the two tools apart in its description', () => {
    const { channels } = channelFixture();
    const tool = createTaskForParticipantTool(channels);
    expect(tool.ref.id).toBe(CREATE_TASK_FOR_PARTICIPANT);
    expect(tool.description).toContain('piece of work');
    expect(tool.description).toContain(MESSAGE_PARTICIPANT);
  });

  test('creates a tracked sub-task on an agent participant, with what done means', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent('billing', () => 'Refund issued.');
    fixture.registry.register(billing.agent);
    const tool = createTaskForParticipantTool(fixture.channels);
    const result = await tool.invoke(
      {
        to: 'billing',
        message: 'Refund order A-1 in full.',
        name: 'Refund A-1',
        acceptanceCriteria: ['The customer has the money back', 7],
      },
      fixture.call(1),
    );
    expect(resultText(result)).toBe('Refund issued.');
    expect(billing.received[0]?.metadata?.[EXT.taskModel]).toEqual({
      name: 'Refund A-1',
      goal: 'Refund order A-1 in full.',
      acceptanceCriteria: ['The customer has the money back'],
      parentTasks: [{ taskId: 't1', contextId: 'ctx-t1', agent: 'self' }],
      depth: 1,
    });
    expect((await fixture.tasks.load('t1')).model.subTasks).toEqual([
      { taskId: 'billing-task', contextId: 'billing-context', agent: 'billing' },
    ]);
  });

  test('names the task after the message when no name is given', async () => {
    const fixture = channelFixture();
    const billing = fakeAgent('billing', () => 'Done.');
    fixture.registry.register(billing.agent);
    const tool = createTaskForParticipantTool(fixture.channels);
    await tool.invoke({ to: 'billing', message: 'x'.repeat(80) }, fixture.call(1));
    expect(billing.received[0]?.metadata?.[EXT.taskModel]).toMatchObject({
      name: 'x'.repeat(60),
      acceptanceCriteria: [],
    });
  });

  test('reports a sub-task that failed', async () => {
    const fixture = channelFixture();
    fixture.registry.register(
      fakeAgent('billing', () => 'No such order.', TaskState.TASK_STATE_FAILED).agent,
    );
    const tool = createTaskForParticipantTool(fixture.channels);
    const result = await tool.invoke({ to: 'billing', message: 'Refund A-9' }, fixture.call(1));
    expect(resultText(result)).toContain('error failed');
    expect(resultText(result)).toContain('No such order.');
  });

  test('cannot give a user a task of their own, and says what to do instead', async () => {
    const { channels, call, tasks } = channelFixture();
    const tool = createTaskForParticipantTool(channels);
    const result = await tool.invoke({ to: 'ada', message: 'Sign the form.' }, call(1));
    expect(resultText(result)).toContain('error unsupported');
    expect(resultText(result)).toContain(MESSAGE_PARTICIPANT);
    expect((await tasks.load('t1')).model.subTasks).toEqual([]);
  });

  test('names the participants when the id is unknown', async () => {
    const { channels, call } = channelFixture();
    const tool = createTaskForParticipantTool(channels);
    const result = await tool.invoke({ to: 'bob', message: 'Do it' }, call(1));
    expect(resultText(result)).toContain('error not-found');
    expect(resultText(result)).toContain('self (agent, assignee)');
  });
});

describe('the ask route of message_participant', () => {
  const ask = (to: Json, message: Json, name = MESSAGE_PARTICIPANT) => ({
    id: 'c1',
    name,
    args: { to, message },
  });

  test('claims a question to a user as a question on the conversation', async () => {
    const { channels } = channelFixture();
    const route = createAskRoute(channels);
    expect(await route('t1', ask('ada', 'Which order?'))).toBe('Which order?');
  });

  test('says whom the question is for when several users are on the task', async () => {
    const { channels } = channelFixture([
      ...PARTICIPANTS,
      { id: 'grace', role: 'admin', kind: 'user' },
    ]);
    const route = createAskRoute(channels);
    expect(await route('t1', ask('ada', 'Which order?'))).toBe('Ada: Which order?');
    expect(await route('t1', ask('grace', 'May I close it?'))).toBe('grace: May I close it?');
  });

  test('leaves everything else to the tool', async () => {
    const { channels } = channelFixture();
    const route = createAskRoute(channels);
    expect(await route('t1', ask('billing', 'Is it paid?'))).toBeNull();
    expect(await route('t1', ask('bob', 'Hi'))).toBeNull();
    expect(await route('t1', ask('ada', ''))).toBeNull();
    expect(await route('t1', ask(7, 'Hi'))).toBeNull();
    expect(await route('t1', { id: 'c1', name: MESSAGE_PARTICIPANT, args: 'ada' })).toBeNull();
    expect(await route('t1', ask('ada', 'Which order?', 'other_tool'))).toBeNull();
  });
});
