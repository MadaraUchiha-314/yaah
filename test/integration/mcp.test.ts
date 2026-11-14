import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskState } from '@a2a-js/sdk';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { Context } from 'cordis';

import type { ToolResult } from '../../src/harness/core/types.ts';
import type { Json } from '../../src/kernel/json.ts';
import type { McpPluginConfig } from '../../src/harness/tools/mcp/index.ts';
import * as mcp from '../../src/harness/tools/mcp/index.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { StubHttp } from '../fixtures/mcp/stub-http.ts';
import { freePort, serveStubHttp } from '../fixtures/mcp/stub-http.ts';
import { MISSING_ORDER, REFUND_DELAY_ENV, REFUND_LOG_ENV } from '../fixtures/mcp/stub-tools.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

const STUB = fileURLToPath(new URL('../fixtures/mcp/stub-server.ts', import.meta.url));

/** `config.toml` text for the stub as a stdio server, started with the running runtime. */
function stdioServer(id: string, env: readonly string[] = []): string {
  return [
    '[[mcp.servers]]',
    `id = ${JSON.stringify(id)}`,
    'transport = "stdio"',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(STUB)}]`,
    `env = ${JSON.stringify(env)}`,
  ].join('\n');
}

function httpServer(id: string, url: string): string {
  return [
    '[[mcp.servers]]',
    `id = ${JSON.stringify(id)}`,
    'transport = "http"',
    `url = "${url}"`,
  ].join('\n');
}

interface Seen {
  readonly unavailable: { serverId: string; retryInMs: number | null }[];
  readonly connected: string[];
}

/**
 * Enables the MCP plugin from the harness's `setup` hook, where the composition is
 * already up. The plugin object (`name`, `inject`, `apply`) goes to `ctx.use` with its
 * config, and the returned fiber is awaited: that waits for the plugin's injected
 * services and for its asynchronous `apply`, so the tools of a reachable server are
 * registered when `startHarness` returns. `ctx.inject([...], inner => apply(inner, cfg))`
 * also works, but hides the plugin's name and repeats its `inject` list.
 */
function enableMcp(seen: Seen, config: McpPluginConfig = {}): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    ctx.on('tools/mcp-unavailable', (serverId, _reason, retryInMs) => {
      seen.unavailable.push({ serverId, retryInMs });
    });
    ctx.on('tools/mcp-connected', (serverId) => {
      seen.connected.push(serverId);
    });
    await ctx.use(mcp, config);
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await sleep(10);
  }
}

function mcpToolIds(harness: TestHarness): string[] {
  return harness.harness.ctx.entities
    .list('tool')
    .map((tool) => tool.ref.id)
    .filter((id) => id.startsWith('mcp__'))
    .toSorted();
}

/** The tool results the model was shown in its `index`-th request. */
function toolResults(harness: TestHarness, index: number): ToolResult[] {
  return (harness.llm.requests[index]?.messages ?? []).flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool-result' ? [block.result] : [])),
  );
}

function textOf(result: ToolResult | undefined): string {
  return result?.ok === true
    ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : '';
}

let running: TestHarness | undefined = undefined;
let stub: StubHttp | undefined = undefined;
let scratch: string | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  await stub?.close();
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
  }
  running = undefined;
  stub = undefined;
  scratch = undefined;
});

describe('MCP tools', () => {
  /**
   * Feature: Tools and MCP
   * Scenario: MCP tools are registered from a configured server
   *   Given a stdio MCP server in the configuration
   *   When the harness starts
   *   Then each of the server's tools is a remote tool entity named mcp__<server>__<tool>
   *   And only read-only or idempotent tools are marked safe to retry
   *   And the model is offered the tools, and a call reaches the server and returns its result
   *   And stopping the harness removes the tools
   * Requirement: docs/specs/issue-3/requirements.md R8.1
   */
  test('MCP tools are registered from a configured server', async () => {
    const seen: Seen = { unavailable: [], connected: [] };
    running = await startHarness({
      config: stdioServer('crm'),
      setup: enableMcp(seen),
      turns: [callTools(call('c1', 'mcp__crm__lookup_order', { id: 'a1' })), say('It shipped.')],
    });
    const { entities } = running.harness.ctx;
    expect(mcpToolIds(running)).toEqual([
      'mcp__crm__dump_env',
      'mcp__crm__lookup_order',
      'mcp__crm__refund',
      'mcp__crm__refund_rules',
    ]);
    expect(seen.connected).toEqual(['crm']);
    const lookup = entities.resolve({ kind: 'tool', id: 'mcp__crm__lookup_order', version: null });
    expect(lookup.description).toBe('Looks an order up by its id.');
    expect(lookup.locality).toEqual({
      type: 'remote',
      protocol: 'mcp',
      url: `stdio:${process.execPath}`,
    });
    expect(lookup.inputSchema).toMatchObject({ type: 'object', required: ['id'] });
    expect(lookup.retrySafe).toBe(true);
    const refund = entities.resolve({ kind: 'tool', id: 'mcp__crm__refund', version: null });
    expect(refund.retrySafe).toBe(false);

    const turn = await running.send('Where is order a1?');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(running.llm.requests[0]?.tools.map((tool) => tool.name)).toContain(
      'mcp__crm__lookup_order',
    );
    const [result] = toolResults(running, 1);
    expect(textOf(result)).toContain('Order a1 is shipped.');
    expect(result).toMatchObject({ ok: true, structured: { id: 'a1', status: 'shipped' } });

    // The registry outlives the context: after the plugin is disposed it holds no MCP tool.
    await running.stop();
    running = undefined;
    expect(entities.list('tool').filter((tool) => tool.ref.id.startsWith('mcp__'))).toEqual([]);
  });

  /**
   * Feature: Tools and MCP
   * Scenario: A non-idempotent MCP tool runs once per call
   *   Given the stub's refund tool, which records every call it serves
   *   When the model calls it once
   *   Then the server served exactly one refund
   * Requirement: docs/specs/issue-3/requirements.md R8.1
   */
  test('A non-idempotent MCP tool runs once per call', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'yaah-mcp-'));
    const log = join(scratch, 'refunds.log');
    process.env[REFUND_LOG_ENV] = log;
    try {
      running = await startHarness({
        config: stdioServer('crm', [REFUND_LOG_ENV]),
        setup: enableMcp({ unavailable: [], connected: [] }),
        turns: [callTools(call('c1', 'mcp__crm__refund', { id: 'a1' })), say('Refunded.')],
      });
      const turn = await running.send('Refund order a1.');
      expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(textOf(toolResults(running, 1)[0])).toBe('Refunded order a1.');
      expect(await readFile(log, 'utf8')).toBe('a1\n');
    } finally {
      delete process.env[REFUND_LOG_ENV];
    }
  });

  /**
   * Feature: Tools and MCP
   * Scenario: An unreachable MCP server does not stop start-up
   *   Given a Streamable HTTP MCP server in the configuration that is not running
   *   When the harness starts
   *   Then start-up succeeds without the server's tools and the failure is reported
   *   And the connection is retried
   *   When the server comes up
   *   Then its tools are registered and a task can use them
   * Requirement: docs/specs/issue-3/requirements.md R8.4
   */
  test('An unreachable MCP server does not stop start-up', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}/mcp`;
    const seen: Seen = { unavailable: [], connected: [] };
    running = await startHarness({
      config: httpServer('docs', url),
      setup: enableMcp(seen, { backoff: { initialMs: 20, maxMs: 80 } }),
      turns: [callTools(call('c1', 'mcp__docs__refund_rules')), say('Thirty days.')],
    });
    expect(mcpToolIds(running)).toEqual([]);
    expect(seen.unavailable[0]).toEqual({ serverId: 'docs', retryInMs: 20 });
    await until(() => seen.unavailable.length >= 3);
    expect(seen.unavailable.slice(0, 3).map((entry) => entry.retryInMs)).toEqual([20, 40, 80]);

    stub = await serveStubHttp(port);
    await until(() => seen.connected.length === 1);
    expect(mcpToolIds(running)).toContain('mcp__docs__refund_rules');
    const rules = running.harness.ctx.entities.resolve({
      kind: 'tool',
      id: 'mcp__docs__refund_rules',
      version: null,
    });
    expect(rules.locality).toEqual({ type: 'remote', protocol: 'mcp', url });

    const turn = await running.send('What are the refund rules?');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(textOf(toolResults(running, 1)[0])).toBe('Refunds are possible within 30 days.');
  });

  /**
   * Feature: Tools and MCP
   * Scenario: MCP tools are served over Streamable HTTP
   *   Given the stub MCP server running behind a Streamable HTTP endpoint
   *   When the harness starts with that endpoint configured
   *   Then the server's tools are registered
   *   And calling them returns results and errors exactly as over stdio
   *   When the endpoint goes away and a tool is called
   *   Then the caller is told the server is unavailable and the tools are withdrawn
   * Requirement: docs/specs/issue-3/requirements.md R8.1, R8.5
   */
  test('MCP tools are served over Streamable HTTP', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'yaah-mcp-'));
    const log = join(scratch, 'refunds.log');
    process.env[REFUND_LOG_ENV] = log;
    process.env[REFUND_DELAY_ENV] = '5';
    try {
      stub = await serveStubHttp(await freePort());
      running = await startHarness({
        config: httpServer('docs', stub.url),
        setup: enableMcp({ unavailable: [], connected: [] }),
      });
      const { entities } = running.harness.ctx;
      const invoke = (tool: string, args: Json = {}): Promise<ToolResult> =>
        entities.resolve({ kind: 'tool', id: `mcp__docs__${tool}`, version: null }).invoke(args, {
          taskId: 'task-1',
          callId: 'c1',
          key: 'step-1',
          signal: new AbortController().signal,
        });
      expect(mcpToolIds(running)).toHaveLength(4);
      expect(await invoke('lookup_order', { id: 'a1' })).toEqual({
        ok: true,
        content: [{ type: 'text', text: 'Order a1 is shipped.' }],
        structured: { id: 'a1', status: 'shipped' },
      });
      expect(await invoke('lookup_order', { id: MISSING_ORDER })).toEqual({
        ok: false,
        error: { code: 'tool-error', message: 'No order has the id missing.' },
      });
      expect(textOf(await invoke('refund', { id: 'b2' }))).toBe('Refunded order b2.');
      expect(await readFile(log, 'utf8')).toBe('b2\n');
      expect(textOf(await invoke('dump_env'))).toContain('PATH');

      await stub.close();
      stub = undefined;
      const lost = await invoke('refund_rules');
      expect(lost.ok ? '' : lost.error.code).toBe('unavailable');
      expect(mcpToolIds(running)).toEqual([]);
    } finally {
      delete process.env[REFUND_LOG_ENV];
      delete process.env[REFUND_DELAY_ENV];
    }
  });

  /**
   * Feature: Tools and MCP
   * Scenario: A failing MCP tool is reported to the model and the task continues
   *   Given a registered MCP tool
   *   When the model calls it and the server reports an error
   *   Then the model is shown a typed error result carrying the server's message
   *   And the task goes on to complete
   * Requirement: docs/specs/issue-3/requirements.md R8.5
   */
  test('A failing MCP tool is reported to the model and the task continues', async () => {
    running = await startHarness({
      config: stdioServer('crm'),
      setup: enableMcp({ unavailable: [], connected: [] }),
      turns: [
        callTools(call('c1', 'mcp__crm__lookup_order', { id: MISSING_ORDER })),
        say('I could not find that order.'),
      ],
    });
    const turn = await running.send('Where is my order?');
    expect(toolResults(running, 1)).toEqual([
      { ok: false, error: { code: 'tool-error', message: 'No order has the id missing.' } },
    ]);
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(turn.streamed).toContain('could not find');
  });

  /**
   * Feature: Tools and MCP
   * Scenario: A tool the MCP server does not offer is refused
   *   Given a connected MCP server
   *   When the model asks for a tool of that server that was never registered
   *   Then the call is refused, the refusal is the tool result, and the task continues
   * Requirement: docs/specs/issue-3/requirements.md abuse case 3
   */
  test('A tool the MCP server does not offer is refused', async () => {
    running = await startHarness({
      config: stdioServer('crm'),
      setup: enableMcp({ unavailable: [], connected: [] }),
      turns: [callTools(call('c1', 'mcp__crm__delete_everything')), say('I cannot do that.')],
    });
    const turn = await running.send('Delete everything.');
    const [result] = toolResults(running, 1);
    expect(result?.ok === false ? result.error.code : '').toBe('not-found');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  /**
   * Feature: Tools and MCP
   * Scenario: A stdio MCP server sees only the environment it was given
   *   Given a credential in the harness's environment
   *   And a stdio MCP server whose configuration names one other variable
   *   When the server reports the names of its environment variables
   *   Then the named variable and PATH are among them
   *   And the credential is not, nor anything else of the harness's environment
   * Requirement: docs/specs/issue-3/requirements.md R8.1 (design: least privilege)
   */
  test('A stdio MCP server sees only the environment it was given', async () => {
    process.env['YAAH_TEST_API_KEY'] = 'sk-test-secret';
    process.env['STUB_VISIBLE'] = 'yes';
    try {
      running = await startHarness({
        config: stdioServer('crm', ['STUB_VISIBLE']),
        setup: enableMcp({ unavailable: [], connected: [] }),
        turns: [callTools(call('c1', 'mcp__crm__dump_env')), say('Done.')],
      });
      await running.send('What can the server see?');
      const parsed: unknown = JSON.parse(textOf(toolResults(running, 1)[0]));
      const names = Array.isArray(parsed) ? parsed.map(String) : [];
      expect(names).toContain('STUB_VISIBLE');
      expect(names).toContain('PATH');
      expect(names).not.toContain('YAAH_TEST_API_KEY');
      // The SDK's stdio transport always adds its own short list of harmless variables.
      const allowed = new Set(['STUB_VISIBLE', 'PATH', ...DEFAULT_INHERITED_ENV_VARS]);
      expect(names.filter((name) => !allowed.has(name))).toEqual([]);
    } finally {
      delete process.env['YAAH_TEST_API_KEY'];
      delete process.env['STUB_VISIBLE'];
    }
  });
});
