import { afterEach, describe, expect, test } from 'bun:test';

import { EXT, SCHEMAS, readExtension } from '../../src/app/api-server/extensions/index.ts';
import { ScriptedLlm, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const longRunning = { [EXT.taskLifecycle]: { longRunning: true } };

function replyText(turn: Awaited<ReturnType<TestHarness['send']>>): string {
  return (turn.reply?.parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

function outcome(turn: Awaited<ReturnType<TestHarness['send']>>) {
  return readExtension(turn.reply?.metadata, EXT.commands, SCHEMAS.commandOutcome);
}

describe('commands', () => {
  /**
   * Feature: Commands
   * Scenario: A command never reaches the model
   *   Given a harness with a second model registered
   *   When the user sends /model with that model's id, then an ordinary message
   *   Then the command is answered directly, without a task and without a model call
   *   And the ordinary message is answered by the selected model
   * Requirement: docs/specs/issue-3/requirements.md R23.1, R23.2, R7.3
   */
  test('A command never reaches the model', async () => {
    const other = new ScriptedLlm([say('From the other model.')], { id: 'scripted/other' });
    running = await startHarness({
      turns: [say('From the default model.')],
      setup: (ctx) => {
        ctx.effect(() => ctx.entities.register(other));
      },
    });
    const command = await running.send('/model scripted/other', { contextId: 'ctx-1' });
    expect(command.task).toBeUndefined();
    expect(replyText(command)).toBe('Model set to scripted/other.');
    expect(outcome(command)).toEqual({ command: 'model', status: 'executed' });
    expect(running.llm.requests.length + other.requests.length).toBe(0);

    const turn = await running.send('Hello', { contextId: 'ctx-1' });
    expect(statusText(turn.task)).toBe('From the other model.');
    expect(running.llm.requests.length).toBe(0);
  });

  /**
   * Feature: Commands
   * Scenario: A command on an open task changes that task
   *   Given a long-running task
   *   When the user sends /effort high on the task, then another message
   *   Then the next model call is made with effort high, and the task stays open
   * Requirement: docs/specs/issue-3/requirements.md R23.2
   */
  test('A command on an open task changes that task', async () => {
    running = await startHarness({ turns: [say('One.'), say('Two.')] });
    const first = await running.send('Hi', { metadata: longRunning });
    const taskId = first.task?.id ?? '';
    const command = await running.send('/effort high', { taskId });
    expect(replyText(command)).toBe('Effort set to high.');
    await running.send('Again', { taskId });
    expect(running.llm.requests[0]?.effort).toBe('medium');
    expect(running.llm.requests[1]?.effort).toBe('high');
  });

  /**
   * Feature: Commands
   * Scenario: An unknown command is reported
   *   Given a running harness
   *   When the user sends a slash command that is not registered
   *   Then the reply says so and lists the commands, and the model is not called
   * Requirement: docs/specs/issue-3/requirements.md R23.5
   */
  test('An unknown command is reported', async () => {
    running = await startHarness({ turns: [say('never')] });
    const turn = await running.send('/frobnicate now');
    expect(replyText(turn)).toContain('Unknown command /frobnicate');
    expect(replyText(turn)).toContain('/model');
    expect(outcome(turn)).toEqual({ command: 'frobnicate', status: 'unknown' });
    expect(running.llm.requests.length).toBe(0);
  });

  /**
   * Feature: Commands
   * Scenario: A plugin registers a command as a name and a function
   *   Given a plugin that registers /ping
   *   When the user sends /ping twice, the second time making it throw
   *   Then the function's text is the reply, a failure is reported as a failure
   *   And the lifecycle events fire in order, and the card lists the command
   * Requirement: docs/specs/issue-3/requirements.md R23.3, R23.4
   */
  test('A plugin registers a command as a name and a function', async () => {
    const events: string[] = [];
    running = await startHarness({
      setup: (ctx) => {
        ctx.commands.register('ping', (args) => {
          if (args === 'boom') {
            throw new Error('no pong');
          }
          return Promise.resolve({ text: `pong ${args}` });
        });
        ctx.on('command/invoked', (name) => {
          events.push(`invoked ${name}`);
        });
        ctx.on('command/executed', (name) => {
          events.push(`executed ${name}`);
        });
        ctx.on('command/failed', (name) => {
          events.push(`failed ${name}`);
        });
      },
    });
    expect(replyText(await running.send('/ping me'))).toBe('pong me');
    const failed = await running.send('/ping boom');
    expect(replyText(failed)).toBe('/ping failed: no pong');
    expect(outcome(failed)).toEqual({ command: 'ping', status: 'failed' });
    expect(events).toEqual(['invoked ping', 'executed ping', 'invoked ping', 'failed ping']);
    const card = running.harness.ctx.a2a.cardFor(running.url);
    const listed = card.capabilities?.extensions.find(
      (extension) => extension.uri === EXT.commands,
    );
    expect(JSON.stringify(listed?.params)).toContain('"ping"');
    expect(JSON.stringify(listed?.params)).toContain('"exit"');
  });

  /**
   * Feature: Commands
   * Scenario: The built-in commands validate what they are given
   *   Given a running harness
   *   When /model or /effort is sent with no argument or with an unknown value
   *   Then the reply shows the current value and the choices, or names the bad value
   * Requirement: docs/specs/issue-3/requirements.md R23.2
   */
  test('The built-in commands validate what they are given', async () => {
    running = await startHarness({});
    expect(replyText(await running.send('/model'))).toContain('scripted/model');
    const badModel = await running.send('/model nope/none');
    expect(replyText(badModel)).toContain('No model "nope/none"');
    expect(outcome(badModel)?.status).toBe('failed');
    expect(replyText(await running.send('/effort'))).toContain('low, medium, high');
    expect(replyText(await running.send('/effort extreme'))).toContain(
      '"extreme" is not an effort level',
    );
    expect(replyText(await running.send('/exit'))).toContain('handled by the interface');
  });
});
