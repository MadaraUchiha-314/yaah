import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;
let release: () => void = () => undefined;

afterEach(async () => {
  release();
  await running?.stop();
  running = undefined;
});

const FAST = '[heartbeat]\ninterval_ms = 100\nstalled_after_ms = 150';

/** A tool that does not return until the test lets it. */
function gate(): ReturnType<typeof defineTool> {
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return defineTool({
    id: 'slow_lookup',
    description: 'Looks something up, slowly.',
    inputSchema: { type: 'object' },
    retrySafe: true,
    invoke: async () => {
      await open;
      return textResult('found');
    },
  });
}

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

describe('heartbeat', () => {
  /**
   * Feature: Heartbeat
   * Scenario: The heartbeat reports a stalled task
   *   Given a harness whose heartbeat fires every 100 ms and calls a task stalled after 150 ms
   *   And a task working on a tool call that does not return
   *   When heartbeats fire
   *   Then one `task/stalled` event names the task, it is logged, and it is not repeated
   *        while the task stays stuck
   *   And once the tool returns and the task finishes, nothing more is reported
   * Requirement: docs/specs/issue-3/requirements.md R16.1, R16.2, R16.3
   */
  test('The heartbeat reports a stalled task', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'yaah-hb-')), 'yaah.log');
    const stalled: string[] = [];
    let ticks = 0;
    running = await startHarness({
      tools: [gate()],
      turns: [callTools(call('c1', 'slow_lookup')), say('Found it.')],
      config: `${FAST}\n[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      setup: (ctx) => {
        ctx.on('task/stalled', (taskId) => {
          stalled.push(taskId);
        });
        ctx.on('heartbeat/tick', () => {
          ticks += 1;
        });
      },
    });
    const turn = running.send('look it up');
    await until(() => stalled.length > 0);
    const seenAt = ticks;
    await until(() => ticks >= seenAt + 3);
    expect(stalled).toHaveLength(1);
    release();
    const done = await turn;
    expect(stalled).toEqual([done.task?.id ?? 'no task']);
    const after = ticks;
    await until(() => ticks >= after + 3);
    expect(stalled).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toContain('"type":"task.stalled"');
  });

  /**
   * Feature: Heartbeat
   * Scenario: The heartbeat hands an untaken inbox item to its task again
   *   Given an inbox item that was stored but never reached its task's run
   *   When a heartbeat fires after the item is older than one interval
   *   Then the item is delivered and the task answers
   *   And an item younger than one interval is left alone
   * Requirement: docs/specs/issue-3/requirements.md R16.2, R15.6
   */
  test('The heartbeat hands an untaken inbox item to its task again', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    running = await startHarness({
      turns: [say('first'), say('second')],
      // The timer is too slow to fire in this test: every beat is the test's own.
      config: '[heartbeat]\ninterval_ms = 600000\n[[overrides]]\nid = "heartbeat"\ndisabled = true',
      setup: async (ctx) => {
        const heartbeat = await import('../../src/app/heartbeat/index.ts');
        await ctx.use(heartbeat, { now: () => now });
      },
    });
    const { ctx } = running.harness;
    const first = await running.send('hello', {
      metadata: { [EXT.taskLifecycle]: { longRunning: true } },
    });
    const taskId = first.task?.id ?? '';
    // Stored, but its delivery was lost.
    await ctx.persistence.inbox.put({
      id: `${taskId}:lost`,
      taskId,
      receivedAt: now.toISOString(),
      interrupt: false,
      payload: { kind: 'message', parts: [{ type: 'text', text: 'are you there?' }] },
    });
    let redelivered = -1;
    ctx.on('heartbeat/tick', (_at, count) => {
      redelivered = count;
    });
    await ctx.heartbeat.beat();
    expect(redelivered).toBe(0);
    now = new Date(now.getTime() + 600_001);
    await ctx.heartbeat.beat();
    expect(redelivered).toBe(1);
    await until(() => running?.llm.requests.length === 2);
    expect(running.llm.requests).toHaveLength(2);
    expect(JSON.stringify(running.llm.requests[1])).toContain('are you there?');
  });
});
