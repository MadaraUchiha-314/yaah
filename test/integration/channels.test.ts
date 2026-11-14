import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { readTaskModel } from '../../src/app/api-server/task-port.ts';
import type { Participant, TaskModel } from '../../src/harness/core/types.ts';
import { definePrompt } from '../../src/harness/system-prompt/prompt.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { SendOptions, TestHarness } from '../support/harness.ts';
import { startHarness, statusText, subStateOf } from '../support/harness.ts';

const running: TestHarness[] = [];

async function start(options: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const harness = await startHarness(options);
  running.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of running.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- two harnesses at most
    await harness.stop();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/** Starts a harness that knows `remote` as the agent "billing". */
async function withBilling(
  remote: TestHarness,
  options: Parameters<typeof startHarness>[0],
): Promise<TestHarness> {
  const parent = await start({
    ...options,
    config: `[[agents]]\nid = "billing"\ncard_url = "${remote.url}/.well-known/agent-card.json"`,
  });
  await waitFor(() =>
    parent.harness.ctx.entities.has({ kind: 'agent', id: 'billing', version: null }),
  );
  return parent;
}

const ADA: Participant = { id: 'ada', role: 'reporter', kind: 'user', displayName: 'Ada' };
const SELF: Participant = { id: 'self', role: 'assignee', kind: 'agent' };
const BILLING: Participant = { id: 'billing', role: 'admin', kind: 'agent' };

/** What a message from participant `id` carries. */
function as(id: string, more: Record<string, unknown> = {}): SendOptions {
  return { metadata: { [EXT.channels]: { from: id }, ...more }, extensions: [EXT.channels] };
}

/** A message from `id` that creates a task with the given participants. */
function creating(id: string, participants: readonly Participant[], keepOpen = false): SendOptions {
  return as(id, {
    [EXT.taskModel]: { participants },
    ...(keepOpen ? { [EXT.taskLifecycle]: { longRunning: true } } : {}),
  });
}

function modelOf(harness: TestHarness, taskId: string | undefined): TaskModel | undefined {
  const stored = harness.harness.ctx.taskRuntime.taskStore.get(taskId ?? '');
  return stored === undefined ? undefined : readTaskModel(stored);
}

function toolResultText(harness: TestHarness, requestIndex: number): string {
  const tool = harness.llm.requests[requestIndex]?.messages.findLast(
    (message) => message.role === 'tool',
  );
  const [block] = tool?.content ?? [];
  if (block?.type !== 'tool-result') {
    return '';
  }
  return block.result.ok
    ? block.result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : `error ${block.result.error.code}: ${block.result.error.message}`;
}

async function refusal(sending: Promise<unknown>): Promise<string> {
  try {
    await sending;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('participants and channels', () => {
  /**
   * Feature: Participants and channels
   * Scenario: A message from a non-participant is rejected
   *   Given an open task whose participants are the user "ada" and the harness
   *   When a message arrives on the task declaring that it comes from "mallory"
   *   Then the call is answered with an A2A error that says "mallory" is not a participant
   *   And the message reaches neither the inbox, the task's history nor a model
   *   And a message that declares no sender is taken as coming from "ada" and is answered
   * Requirement: docs/specs/issue-3/requirements.md R12.3, R12.5
   */
  test('A message from a non-participant is rejected', async () => {
    const harness = await start({ turns: [say('Hello Ada.'), say('Still here.')] });
    const accepted: string[] = [];
    harness.harness.ctx.on('inbox/accepted', (item) => {
      accepted.push(item.id);
    });
    const first = await harness.send('Hi', creating('ada', [ADA, SELF], true));
    const taskId = first.task?.id ?? '';
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    const streamed = await refusal(harness.send('Let me in', { ...as('mallory'), taskId }));
    expect(streamed).toContain('"mallory" is not a participant of channel');
    expect(streamed).not.toContain('ada');
    const blocking = await refusal(
      harness.client.sendMessage({
        tenant: '',
        message: harness.message('Let me in', { ...as('mallory'), taskId }),
        configuration: undefined,
        metadata: undefined,
      }),
    );
    expect(blocking).toContain('"mallory" is not a participant of channel');

    expect(harness.llm.requests).toHaveLength(1);
    expect(accepted).toHaveLength(1);
    const stored = harness.harness.ctx.taskRuntime.taskStore.get(taskId);
    expect(JSON.stringify(stored?.history)).not.toContain('Let me in');
    expect(stored?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    const undeclared = await harness.send('Are you there?', { taskId });
    expect(statusText(undeclared.task)).toBe('Still here.');
  });

  /**
   * Feature: Participants and channels
   * Scenario: A quick question to a participant returns their reply
   *   Given a task whose participants are the user "ada", the harness and the agent "billing"
   *   When the model sends "ada" a question with message_participant
   *   Then the task waits for input with the question as its status, as with ask_user
   *   And ada's next message is the result of that tool call
   *   When the model sends "billing" a question with message_participant
   *   Then the agent is asked over A2A and its answer is the result of the tool call
   *   And no sub-task is recorded for the question
   * Requirement: docs/specs/issue-3/requirements.md R12.2, R12.3, R14.5
   */
  test('A quick question to a participant returns their reply', async () => {
    const remote = await start({ turns: [say('Invoice 7 is paid.')] });
    const parent = await withBilling(remote, {
      turns: [
        callTools(call('c1', 'message_participant', { to: 'ada', message: 'Which invoice?' })),
        callTools(
          call('c2', 'message_participant', { to: 'billing', message: 'Is invoice 7 paid?' }),
        ),
        say('Invoice 7 is paid.'),
      ],
    });
    const asked = await parent.send('Is my invoice paid?', creating('ada', [ADA, SELF, BILLING]));
    expect(asked.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(subStateOf(asked.task)).toBe('awaiting-user-input');
    expect(statusText(asked.task)).toBe('Which invoice?');

    const answered = await parent.send('Invoice 7', { ...as('ada'), taskId: asked.task?.id ?? '' });
    expect(toolResultText(parent, 1)).toBe('Invoice 7');
    const calls = JSON.stringify(parent.llm.requests[1]?.messages);
    expect(calls).toContain('"name":"message_participant"');
    expect(calls).not.toContain('"name":"ask_user"');

    expect(toolResultText(parent, 2)).toBe('Invoice 7 is paid.');
    expect(JSON.stringify(remote.llm.requests[0]?.messages)).toContain('Is invoice 7 paid?');
    expect(statusText(answered.task)).toBe('Invoice 7 is paid.');
    expect(answered.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(modelOf(parent, asked.task?.id)?.subTasks).toEqual([]);
  });

  /**
   * Feature: Participants and channels
   * Scenario: A task is created for a participant
   *   Given a task whose participants are the user "ada", the harness and the agent "billing"
   *   When the model creates a task for "billing" with create_task_for_participant
   *   Then "billing" gets a task of its own with the name, goal and acceptance criteria given
   *   And that task is recorded as a sub-task of the caller's task, with its parent and depth set
   *   And its outcome is the result of the tool call
   *   When the model names a participant that is not on the task, or asks a user to take a task
   *   Then the result is an error that names the participants, or points at message_participant
   * Requirement: docs/specs/issue-3/requirements.md R12.2, R12.3, R4.5
   */
  test('A task is created for a participant', async () => {
    const remote = await start({ turns: [say('Refund of 84 EUR issued.')] });
    const work = {
      to: 'billing',
      name: 'Refund A-1',
      message: 'Refund order A-1 in full.',
      acceptanceCriteria: ['The customer has the money back'],
    };
    const parent = await withBilling(remote, {
      turns: [
        callTools(call('c1', 'create_task_for_participant', work)),
        callTools(
          call('c2', 'create_task_for_participant', { to: 'bob', message: 'Do it' }),
          call('c3', 'create_task_for_participant', { to: 'ada', message: 'Sign the form' }),
        ),
        say('Your refund is on its way.'),
      ],
    });
    const turn = await parent.send('Refund my order', creating('ada', [ADA, SELF, BILLING]));
    expect(statusText(turn.task)).toBe('Your refund is on its way.');
    expect(toolResultText(parent, 1)).toBe('Refund of 84 EUR issued.');

    const [link] = modelOf(parent, turn.task?.id)?.subTasks ?? [];
    expect(link?.agent).toBe('billing');
    const child = modelOf(remote, link?.taskId);
    expect(child?.name).toBe('Refund A-1');
    expect(child?.goal).toBe('Refund order A-1 in full.');
    expect(child?.acceptanceCriteria).toEqual(['The customer has the money back']);
    expect(child?.parentTasks[0]?.taskId).toBe(turn.task?.id);
    expect(child?.depth).toBe(1);
    expect(child?.participants.find((participant) => participant.role === 'assignee')?.id).toBe(
      'self',
    );

    const refusals = JSON.stringify(parent.llm.requests[2]?.messages);
    expect(refusals).toContain('No participant \\"bob\\" is on this task.');
    expect(refusals).toContain(
      'ada (user, reporter), self (agent, assignee), billing (agent, admin)',
    );
    expect(refusals).toContain('cannot be given a task of their own');
    expect(modelOf(parent, turn.task?.id)?.subTasks).toHaveLength(1);
  });

  /**
   * Feature: Participants and channels
   * Scenario: Only the harness changes a channel's participants
   *   Given an open task whose participants are the user "ada" and the harness
   *   When "ada" sends a message whose task-model data lists "mallory" as a participant
   *   Then the task's participants are unchanged and "mallory" is still rejected
   *   When the harness adds "grace" through the channel manager
   *   Then a message from "grace" is accepted
   *   When the harness removes "grace" through the channel manager
   *   Then a message from "grace" is rejected again
   * Requirement: docs/specs/issue-3/requirements.md R12.4, R12.5
   */
  test("Only the harness changes a channel's participants", async () => {
    const harness = await start({ turns: [say('One.'), say('Two.'), say('Three.')] });
    const first = await harness.send('Hi', creating('ada', [ADA, SELF], true));
    const taskId = first.task?.id ?? '';
    const mallory: Participant = { id: 'mallory', role: 'admin', kind: 'user' };

    const sneaky = await harness.send('Add my friend', {
      ...as('ada', { [EXT.taskModel]: { participants: [ADA, SELF, mallory] } }),
      taskId,
    });
    expect(statusText(sneaky.task)).toBe('Two.');
    expect(modelOf(harness, taskId)?.participants).toEqual([ADA, SELF]);
    expect(await refusal(harness.send('Hello', { ...as('mallory'), taskId }))).toContain(
      'not a participant',
    );

    const { channels } = harness.harness.ctx;
    expect((await channels.forTask(taskId)).participants).toEqual([ADA, SELF]);
    await channels.addParticipant(taskId, { id: 'grace', role: 'watcher', kind: 'user' });
    const welcomed = await harness.send('Hello', { ...as('grace'), taskId });
    expect(statusText(welcomed.task)).toBe('Three.');

    await channels.removeParticipant(taskId, 'grace');
    expect(await refusal(harness.send('Hello again', { ...as('grace'), taskId }))).toContain(
      '"grace" is not a participant',
    );
    expect(harness.llm.requests).toHaveLength(3);
  });

  /**
   * Feature: Participants and channels
   * Scenario: The model is shown the participants and what each role means
   *   Given a task created by a sender who declares the id "ada"
   *   When the context is built
   *   Then it lists "ada" as reporter and the harness as assignee, by the ids the tools take
   *   And it says what each role means
   *   And the two participant tools are declared, each pointing at the other
   *   And the agent card declares the channels extension
   *   When an operator overrides the "roles" prompt
   *   Then the context carries the operator's text instead
   * Requirement: docs/specs/issue-3/requirements.md R12.1, R12.2, R10.2
   */
  test('The model is shown the participants and what each role means', async () => {
    const harness = await start({ turns: [say('Hello.')] });
    await harness.send('Hi', as('ada'));
    const [request] = harness.llm.requests;
    const context = JSON.stringify(request?.messages);
    expect(context).toContain('- ada (user): reporter');
    expect(context).toContain('- self (agent): assignee');
    expect(context).toContain('**watcher** — is kept informed.');
    const tools = new Map(request?.tools.map((tool) => [tool.name, tool.description]));
    expect(tools.get('message_participant')).toContain('create_task_for_participant');
    expect(tools.get('create_task_for_participant')).toContain('message_participant');
    const card = await harness.client.getAgentCard();
    expect(card.capabilities?.extensions.map((extension) => extension.uri)).toContain(EXT.channels);

    const overridden = await start({
      turns: [say('Hello.')],
      setup: (ctx) => {
        ctx.entities.register(
          definePrompt({ id: 'roles', template: 'WHO IS HERE\n{{participants}}' }),
          { override: true },
        );
      },
    });
    await overridden.send('Hi', creating('ada', [ADA, SELF]));
    const custom = JSON.stringify(overridden.llm.requests[0]?.messages);
    expect(custom).toContain('WHO IS HERE\\n- ada — Ada (user): reporter');
    expect(custom).not.toContain('**watcher**');
  });
});
