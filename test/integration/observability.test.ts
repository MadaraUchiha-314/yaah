import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { LlmError } from '../../src/harness/models/llm/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { currentTraceparent } from '../../src/kernel/trace-context.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import type { Collector } from '../support/otlp.ts';
import { startCollector } from '../support/otlp.ts';

let running: TestHarness | undefined = undefined;
let collector: Collector | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  await collector?.stop();
  running = undefined;
  collector = undefined;
});

interface LogRecord {
  readonly type: string;
  readonly level: string;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly traceId?: string;
  readonly stepName?: string;
  readonly [field: string]: unknown;
}

function isLogRecord(value: unknown): value is LogRecord {
  return typeof value === 'object' && value !== null && 'type' in value && 'level' in value;
}

function readLog(path: string): LogRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): LogRecord => {
      const parsed: unknown = JSON.parse(line);
      if (!isLogRecord(parsed)) {
        throw new Error(`not a log record: ${line}`);
      }
      return parsed;
    });
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'yaah-o11y-')), 'yaah.log');
}

describe('observability', () => {
  /**
   * Feature: Observability
   * Scenario: Every step of a task is logged with task and trace ids
   *   Given a harness writing its log to a file
   *   When a message makes the agent call a tool and then answer
   *   Then the log holds one JSON record for the accepted message and for every step —
   *        state written, context built, model invoked, tool invoked, each transition —
   *        and every one of them carries the task id, the context id, one shared trace
   *        id and the step name
   * Requirement: docs/specs/issue-3/requirements.md R18.1, R18.3
   */
  test('Every step of a task is logged with task and trace ids', async () => {
    const path = logFile();
    const lookup = defineTool({
      id: 'lookup',
      description: 'Look an order up.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () => Promise.resolve(textResult('order found')),
    });
    running = await startHarness({
      tools: [lookup],
      turns: [callTools(call('c1', 'lookup')), say('On its way.')],
      config: `[o11y]\nlog_level = "debug"\nlog_file = ${JSON.stringify(path)}`,
    });
    const turn = await running.send('Where is my order?');
    await running.stop();
    running = undefined;

    const records = readLog(path);
    const steps = records.filter((record) => record.stepName !== undefined);
    expect(new Set(steps.map((record) => record.type))).toEqual(
      new Set(['state.written', 'context.built', 'llm.invoked', 'tool.invoked', 'task.transition']),
    );
    const accepted = records.find((record) => record.type === 'inbox.accepted');
    expect(accepted?.taskId).toBe(turn.task?.id);
    expect(records.some((record) => record.type === 'request.received')).toBe(true);
    for (const record of steps) {
      expect(record.taskId).toBe(turn.task?.id);
      expect(record.contextId).toBe(turn.task?.contextId);
      expect(record.traceId).toBe(accepted?.traceId);
      expect(record['outcome']).toBe('ok');
      expect(typeof record['durationMs']).toBe('number');
    }
    expect(accepted?.traceId).toMatch(/^[0-9a-f]{32}$/u);
    const model = steps.filter((record) => record.type === 'llm.invoked');
    expect(model).toHaveLength(2);
    expect(model[0]?.['requestModel']).toBe('scripted/model');
    expect(typeof model[0]?.['usageInputTokens']).toBe('number');
    expect(steps.find((record) => record.type === 'tool.invoked')?.['toolName']).toBe('lookup');
  });

  /**
   * Feature: Observability
   * Scenario: One trace spans the A2A call, the model call and the tool call
   *   Given a harness exporting spans to an OTLP collector
   *   When a message makes the agent call a tool and then answer
   *   Then the collector receives a request span, a `chat <model>` span and an
   *        `execute_tool <name>` span in one trace, the step spans children of the request,
   *        and the tool saw a `traceparent` of that trace to pass on to what it calls
   *   And no message content is on any span
   * Requirement: docs/specs/issue-3/requirements.md R18.2
   */
  test('One trace spans the A2A call, the model call and the tool call', async () => {
    collector = await startCollector();
    const seen: (string | undefined)[] = [];
    const lookup = defineTool({
      id: 'lookup',
      description: 'Look an order up.',
      inputSchema: { type: 'object' },
      retrySafe: true,
      invoke: () => {
        seen.push(currentTraceparent());
        return Promise.resolve(textResult('order found'));
      },
    });
    running = await startHarness({
      tools: [lookup],
      turns: [callTools(call('c1', 'lookup')), say('On its way.')],
      config: `[o11y]\nlog_level = "error"\notlp_endpoint = "${collector.url}/"`,
    });
    await running.send('Where is my private order?');
    await running.stop();
    running = undefined;

    const request = collector.spans.find((span) => span.name === 'POST /a2a');
    const chat = collector.spans.filter((span) => span.name === 'chat scripted/model');
    const tool = collector.spans.find((span) => span.name === 'execute_tool lookup');
    expect(request).toBeDefined();
    expect(chat).toHaveLength(2);
    expect(tool?.traceId).toBe(request?.traceId);
    expect(tool?.parentSpanId).toBe(request?.spanId);
    expect(chat[0]?.traceId).toBe(request?.traceId);
    expect(chat[0]?.attributes['gen_ai.operation.name']).toBe('chat');
    expect(chat[0]?.attributes['gen_ai.request.model']).toBe('scripted/model');
    expect(tool?.attributes['gen_ai.tool.name']).toBe('lookup');
    expect(tool?.attributes['gen_ai.tool.call.id']).toBe('c1');
    expect(seen[0]).toBe(`00-${String(tool?.traceId)}-${String(tool?.spanId)}-01`);
    expect(currentTraceparent()).toBeUndefined();
    expect(collector.body()).not.toContain('private order');
    expect(collector.body()).not.toContain('On its way');
  });

  /**
   * Feature: Observability
   * Scenario: A caller's trace is continued
   *   Given a harness exporting spans
   *   When a request arrives with a W3C `traceparent` header
   *   Then the request's span belongs to the caller's trace, under the caller's span
   * Requirement: docs/specs/issue-3/requirements.md R18.2
   */
  test("A caller's trace is continued", async () => {
    collector = await startCollector();
    running = await startHarness({
      config: `[o11y]\nlog_level = "error"\notlp_endpoint = "${collector.url}"`,
    });
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const response = await fetch(`${running.url}/.well-known/agent-card.json`, {
      headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
    });
    expect(response.status).toBe(200);
    await response.text();
    await running.stop();
    running = undefined;
    const span = collector.spans.find((entry) => entry.traceId === traceId);
    expect(span?.name).toBe('GET /.well-known/agent-card.json');
    expect(span?.parentSpanId).toBe('b7ad6b7169203331');
    expect(span?.attributes['http.response.status_code']).toBe(200);
  });

  /**
   * Feature: Observability
   * Scenario: A failing step is logged as an error and its span is marked failed
   *   Given a model that fails on its first call
   *   When a message is sent
   *   Then the log holds an `llm.invoked` record with outcome `error` at level `error`
   *   And a command is logged when it is invoked and when it has run
   * Requirement: docs/specs/issue-3/requirements.md R18.1, R23.4
   */
  test('A failing step is logged as an error, and commands are logged', async () => {
    const path = logFile();
    collector = await startCollector();
    running = await startHarness({
      turns: [{ error: new LlmError('scripted', 'scripted/model', false, 'model is down') }],
      config: `[o11y]\nlog_file = ${JSON.stringify(path)}\notlp_endpoint = "${collector.url}"`,
    });
    await running.send('/effort high');
    await running.send('hello');
    await running.stop();
    running = undefined;
    const records = readLog(path);
    const failed = records.find((record) => record['outcome'] === 'error');
    expect(failed?.type).toBe('llm.invoked');
    expect(failed?.level).toBe('error');
    expect(failed?.['error']).toContain('model is down');
    expect(
      records.filter((record) => record.type.startsWith('command.')).map((r) => r.type),
    ).toEqual(['command.invoked', 'command.executed']);
    const span = collector.spans.find((entry) => entry.name === 'chat scripted/model');
    expect(span?.raw).toContain('model is down');
    expect(span?.attributes['error.type']).toBe('LlmError');
  });
});
