import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { SystemOneError } from '../../src/harness/models/system-one/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { ScriptedDecision } from '../../src/testing/scripted-system-one.ts';
import { ScriptedSystemOne, answerAll } from '../../src/testing/scripted-system-one.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const TRIAGE_ON = '[inbox]\ntriage = "system-one"\ntriage_model = "scripted/system-one"';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A tool that takes `ms` and writes to `log` when it starts and when it is aborted. */
function slow(ms: number, log: string[]): ReturnType<typeof defineTool> {
  return defineTool({
    id: 'work',
    description: 'work',
    inputSchema: { type: 'object' },
    invoke: async (_args, ctx) => {
      log.push('work started');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          log.push('work aborted');
          resolve();
        });
      });
      return textResult('work done');
    },
  });
}

interface Working {
  readonly harness: TestHarness;
  readonly systemOne: ScriptedSystemOne;
  readonly log: string[];
  readonly taskId: string;
  /** Settles when the stream of the message that started the work has ended. */
  readonly first: Promise<void>;
}

/** Waits for a streaming call to end, however it ends: these tests read the harness. */
async function settled(stream: Promise<unknown>): Promise<void> {
  await stream.catch(() => undefined);
}

/** Sends a message for `taskId` and waits for its stream to end. */
function sendTo(
  harness: TestHarness,
  taskId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return settled(harness.send(text, metadata === undefined ? { taskId } : { taskId, metadata }));
}

/** Waits until the model has been called twice and the task's turn has ended. */
async function turnEnded(harness: TestHarness, taskId: string): Promise<string> {
  const { taskStore } = harness.harness.ctx.taskRuntime;
  for (;;) {
    const task = taskStore.get(taskId);
    const text = statusText(task);
    if (harness.llm.requests.length >= 2 && text !== '') {
      return text;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling the task store
    await sleep(5);
  }
}

/** Starts a harness and a task whose tool call, taking `toolMs`, is in progress. */
async function working(
  decisions: readonly ScriptedDecision[],
  toolMs: number,
  config: string = TRIAGE_ON,
): Promise<Working> {
  const log: string[] = [];
  const systemOne = new ScriptedSystemOne(decisions);
  const harness = await startHarness({
    tools: [slow(toolMs, log)],
    turns: [callTools(call('c1', 'work')), say('Done.')],
    config,
    setup: (ctx) => {
      registerEntity(ctx, systemOne);
    },
  });
  running = harness;
  const first = settled(harness.send('Start the work'));
  while (log.length === 0) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for the tool to start
    await sleep(2);
  }
  const taskId = harness.harness.ctx.taskRuntime.taskStore.open()[0]?.id ?? '';
  return { harness, systemOne, log, taskId, first };
}

/** The text the model was shown in its second call. */
function secondRequest(harness: TestHarness): string {
  return JSON.stringify(harness.llm.requests[1]?.messages);
}

describe('inbox triage', () => {
  /**
   * Feature: Inbox and events
   * Scenario: With triage on, an unmarked message for a working task is classified
   *   Given a harness with `inbox.triage = "system-one"` and a task whose tool call is in
   *         progress
   *   When a message arrives that does not say whether it interrupts
   *   Then System One is asked one yes/no question about the message text
   *   And on "yes" the tool call is aborted and the next model call sees the message
   * Requirement: docs/specs/issue-3/requirements.md R7.5, R7.6
   */
  test('With triage on, an unmarked message for a working task is classified: yes', async () => {
    const { harness, systemOne, log, taskId, first } = await working([answerAll(0.93)], 5000);
    await sendTo(harness, taskId, 'Stop, do this instead');
    expect(await turnEnded(harness, taskId)).toBe('Done.');
    await first;
    expect(log).toEqual(['work started', 'work aborted']);
    expect(systemOne.calls.length).toBe(1);
    expect(systemOne.calls[0]?.input).toEqual({ text: 'Stop, do this instead' });
    const [question] = systemOne.calls[0]?.questions ?? [];
    expect(question?.type).toBe('predicate');
    expect(question?.text).toContain('change or cancel what the agent is doing right now');
    expect(secondRequest(harness)).toContain('Stop, do this instead');
    expect(secondRequest(harness)).toContain('interrupted');
  });

  /**
   * Feature: Inbox and events
   * Scenario: With triage on, an unmarked message for a working task is classified
   *   Given a harness with `inbox.triage = "system-one"` and a task whose tool call is in
   *         progress
   *   When a message arrives that does not say whether it interrupts
   *   And System One answers "no"
   *   Then the tool call finishes and the message is read at the next iteration
   * Requirement: docs/specs/issue-3/requirements.md R7.5, R7.6, R15.5
   */
  test('With triage on, an unmarked message for a working task is classified: no', async () => {
    const { harness, systemOne, log, taskId, first } = await working([answerAll(0.04)], 150);
    await sendTo(harness, taskId, 'Also, thank you');
    await turnEnded(harness, taskId);
    await first;
    expect(log).toEqual(['work started']);
    expect(systemOne.calls.length).toBe(1);
    expect(secondRequest(harness)).toContain('work done');
    expect(secondRequest(harness)).toContain('Also, thank you');
  });

  /**
   * Feature: Inbox and events
   * Scenario: A marked message is not classified
   *   Given a harness with triage on and a task whose tool call is in progress
   *   When a message arrives marked as not interrupting, and then one marked as interrupting
   *   Then System One is not called, and only the second aborts the tool call
   * Requirement: docs/specs/issue-3/requirements.md R7.6, R15.5
   */
  test('A marked message is not classified', async () => {
    const { harness, systemOne, log, taskId, first } = await working([answerAll(0.93)], 5000);
    const mark = (interrupt: boolean): Record<string, unknown> => ({
      [EXT.inboxEvents]: { interrupt },
    });
    const quiet = sendTo(harness, taskId, 'By the way', mark(false));
    await sleep(60);
    expect(log).toEqual(['work started']);
    const stop = sendTo(harness, taskId, 'Stop', mark(true));
    await turnEnded(harness, taskId);
    await Promise.all([first, quiet, stop]);
    expect(log).toEqual(['work started', 'work aborted']);
    expect(systemOne.calls.length).toBe(0);
  });

  /**
   * Feature: Inbox and events
   * Scenario: With triage off System One is never called
   *   Given a harness with the default configuration and a registered System One model
   *   When an unmarked message arrives for a task whose tool call is in progress
   *   Then System One is not called and the tool call finishes
   * Requirement: docs/specs/issue-3/requirements.md R7.6
   */
  test('With triage off System One is never called', async () => {
    const { harness, systemOne, log, taskId, first } = await working([answerAll(0.93)], 150, '');
    await sendTo(harness, taskId, 'Stop, do this instead');
    await turnEnded(harness, taskId);
    await first;
    expect(log).toEqual(['work started']);
    expect(systemOne.calls.length).toBe(0);
    expect(secondRequest(harness)).toContain('Stop, do this instead');
  });

  /**
   * Feature: Inbox and events
   * Scenario: A System One failure does not interrupt
   *   Given a harness with triage on, writing its log to a file, whose System One model fails
   *   When an unmarked message arrives for a task whose tool call is in progress
   *   Then the tool call finishes, the message is read at the next iteration
   *   And the log holds a warning that triage failed, naming the task and the model
   * Requirement: docs/specs/issue-3/requirements.md R7.6
   */
  test('A System One failure does not interrupt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yaah-triage-')), 'yaah.log');
    const error = new SystemOneError('scripted', 'scripted/system-one', true, 'rate limited');
    const { harness, systemOne, log, taskId, first } = await working(
      [{ error }],
      150,
      `${TRIAGE_ON}\n[o11y]\nlog_level = "info"\nlog_file = ${JSON.stringify(path)}`,
    );
    await sendTo(harness, taskId, 'Stop, do this instead');
    await turnEnded(harness, taskId);
    await first;
    expect(log).toEqual(['work started']);
    expect(systemOne.calls.length).toBe(1);
    expect(secondRequest(harness)).toContain('Stop, do this instead');
    const records = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('inbox/triaged'))
      .map((line): unknown => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({
        level: 'warn',
        type: 'harness.event',
        taskId,
        model: 'scripted/system-one',
        interrupt: false,
        error: 'rate limited',
      }),
    ]);
  });
});
