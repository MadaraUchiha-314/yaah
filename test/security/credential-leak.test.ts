import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import type { Collector } from '../support/otlp.ts';
import { startCollector } from '../support/otlp.ts';

const KEY = 'sk-live-0123456789abcdef';

let running: TestHarness | undefined = undefined;
let collector: Collector | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  await collector?.stop();
  running = undefined;
  collector = undefined;
});

describe('abuse case 12: credential leak', () => {
  /**
   * Feature: Security
   * Scenario: A credential that surfaces in an error or a tool result leaves by no exit
   *   Given a harness that knows a provider key
   *   And a tool whose failure message contains the key, and one whose result echoes it
   *   When the agent calls both and answers
   *   Then the key is absent from the log, from every exported span, from everything the
   *        client was streamed, and from the context the model is sent next
   * Requirement: docs/specs/issue-3/requirements.md R18.4; Security considerations,
   *   abuse case 12
   */
  test('A credential that surfaces in an error or a tool result leaves by no exit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yaah-leak-')), 'yaah.log');
    collector = await startCollector();
    const failing = defineTool({
      id: 'failing',
      description: 'Fails, quoting a key.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () => Promise.reject(new Error(`failed using ${KEY}`)),
    });
    const echo = defineTool({
      id: 'echo',
      description: 'Echoes a key.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () => Promise.resolve(textResult(`your key is ${KEY}`)),
    });
    running = await startHarness({
      tools: [failing, echo],
      turns: [callTools(call('c1', failing.ref.id), call('c2', 'echo')), say('Done.')],
      config: [
        '[o11y]',
        'log_level = "debug"',
        `log_file = ${JSON.stringify(path)}`,
        `otlp_endpoint = "${collector.url}"`,
      ].join('\n'),
      setup: (ctx) => {
        ctx.redactor.add(KEY);
      },
    });
    const { llm } = running;
    const turn = await running.send('use the tools');
    await running.stop();
    running = undefined;

    expect(llm.requests).toHaveLength(2);
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
    expect(collector.spans.length).toBeGreaterThan(3);
    expect(collector.body()).not.toContain(KEY);
    expect(JSON.stringify(turn.events)).not.toContain(KEY);
    expect(JSON.stringify(llm.requests)).not.toContain(KEY);
    expect(JSON.stringify(llm.requests[1])).toContain('[redacted]');
  });

  /**
   * Feature: Security
   * Scenario: A credential in a tool's data part or artifact reaches neither model nor client
   *   Given a harness that knows a provider key
   *   And a tool whose result has a data part and an artifact that both contain the key
   *   When the agent calls it and answers
   *   Then the key is absent from the context the model is sent next
   *   And from everything the client was streamed and from the task's artifacts
   * Requirement: docs/specs/issue-3/requirements.md R18.4; abuse case 12
   *   (self-review 1, core #4)
   */
  test('A credential in a tool data part or artifact reaches neither model nor client', async () => {
    const leaky = defineTool({
      id: 'leaky',
      description: 'Returns a key in data and in an artifact.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () =>
        Promise.resolve({
          ok: true,
          content: [{ type: 'data', mediaType: 'application/json', data: { note: KEY } }],
          artifacts: [
            { type: 'text', text: `report for ${KEY}` },
            { type: 'data', mediaType: 'application/json', data: { list: [KEY] } },
          ],
        }),
    });
    running = await startHarness({
      tools: [leaky],
      turns: [callTools(call('c1', 'leaky')), say('Done.')],
      setup: (ctx) => {
        ctx.redactor.add(KEY);
      },
    });
    const { llm } = running;
    const turn = await running.send('use the tool');
    const taskId = turn.task?.id ?? '';
    const task = await running.client.getTask({ tenant: '', id: taskId, historyLength: undefined });

    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests)).not.toContain(KEY);
    expect(JSON.stringify(llm.requests[1])).toContain('[redacted]');
    expect(task.artifacts.length).toBeGreaterThan(0);
    expect(JSON.stringify(task.artifacts)).not.toContain(KEY);
    expect(JSON.stringify(turn.events)).not.toContain(KEY);
  });

  /**
   * Feature: Security
   * Scenario: A credential in a tool's file part reaches neither model nor client
   *   Given a harness that knows a provider key
   *   And a tool whose result has a file named after the key and an image artifact whose
   *       URL carries the key
   *   When the agent calls it and answers
   *   Then the key is absent from the context the model is sent next
   *   And from everything the client was streamed and from the task's artifacts
   * Requirement: docs/specs/issue-3/requirements.md R18.4; abuse case 12
   *   (self-review 2, #2)
   */
  test('A credential in a tool file part reaches neither model nor client', async () => {
    const leaky = defineTool({
      id: 'leaky',
      description: 'Returns a key in a file name and in a file URL.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () =>
        Promise.resolve({
          ok: true,
          content: [
            {
              type: 'file',
              mediaType: 'text/plain',
              name: `db://x?token=${KEY}`,
              source: { kind: 'base64', data: 'aGk=' },
            },
          ],
          artifacts: [
            {
              type: 'file',
              mediaType: 'image/png',
              name: `chart-${KEY}.png`,
              source: { kind: 'url', url: `https://img.example/c.png?key=${KEY}` },
            },
          ],
        }),
    });
    running = await startHarness({
      tools: [leaky],
      turns: [callTools(call('c1', 'leaky')), say('Done.')],
      setup: (ctx) => {
        ctx.redactor.add(KEY);
      },
    });
    const { llm } = running;
    const turn = await running.send('use the tool');
    const taskId = turn.task?.id ?? '';
    const task = await running.client.getTask({ tenant: '', id: taskId, historyLength: undefined });

    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests)).not.toContain(KEY);
    expect(task.artifacts.length).toBeGreaterThan(0);
    expect(JSON.stringify(task.artifacts)).not.toContain(KEY);
    expect(JSON.stringify(task.artifacts)).toContain('[redacted]');
    expect(JSON.stringify(turn.events)).not.toContain(KEY);
  });
});
