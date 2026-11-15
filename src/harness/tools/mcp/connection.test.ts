import { describe, expect, test } from 'bun:test';

import { ProtocolError } from '@modelcontextprotocol/client';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { EntityRegistry } from '../../../kernel/registry.ts';
import type { ToolResult } from '../../core/types.ts';
import type { ToolCallContext } from '../types.ts';
import { defineTool, textResult } from '../types.ts';
import type { McpEvents } from './connection.ts';
import { ServerConnection } from './connection.ts';
import type { McpSession, RemoteTool } from './session.ts';
import { McpConfigError } from './transport.ts';

const server: McpServerConfig = {
  id: 'crm',
  transport: 'http',
  command: undefined,
  args: [],
  env: [],
  url: 'http://127.0.0.1:9/mcp',
};

const lookup: RemoteTool = {
  name: 'lookup_order',
  description: 'Looks an order up.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await sleep(2);
  }
}

class FakeSession implements McpSession {
  closed = false;
  calls: { name: string; args: unknown }[] = [];
  #listener: (() => void) | undefined;
  readonly #tools: readonly RemoteTool[];
  readonly #call: McpSession['callTool'];

  constructor(tools: readonly RemoteTool[], call?: McpSession['callTool']) {
    this.#tools = tools;
    this.#call = call ?? (() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }));
  }

  listTools(): Promise<readonly RemoteTool[]> {
    return Promise.resolve(this.#tools);
  }

  callTool: McpSession['callTool'] = (name, args, signal) => {
    this.calls.push({ name, args });
    return this.#call(name, args, signal);
  };

  onClose(listener: () => void): void {
    this.#listener = listener;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The server went away. */
  drop(): void {
    this.#listener?.();
  }
}

interface Recorded {
  readonly events: McpEvents;
  readonly connected: string[][];
  readonly unavailable: { reason: string; retryInMs: number | null }[];
  readonly skipped: { tool: string; reason: string }[];
}

function record(): Recorded {
  const connected: string[][] = [];
  const unavailable: { reason: string; retryInMs: number | null }[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  return {
    connected,
    unavailable,
    skipped,
    events: {
      connected: (_id, ids) => {
        connected.push([...ids]);
      },
      unavailable: (_id, reason, retryInMs) => {
        unavailable.push({ reason, retryInMs });
      },
      skipped: (_id, tool, reason) => {
        skipped.push({ tool, reason });
      },
    },
  };
}

const backoff = { initialMs: 4, factor: 2, maxMs: 10 };

function callContext(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return { taskId: 'task-1', callId: 'c1', key: 'step-1', signal };
}

function toolIds(registry: EntityRegistry): string[] {
  return registry.list('tool').map((tool) => tool.ref.id);
}

function invoke(registry: EntityRegistry, id: string, args = {}): Promise<ToolResult> {
  return registry.resolve({ kind: 'tool', id, version: null }).invoke(args, callContext());
}

describe('ServerConnection', () => {
  test('registers the tools of a server that connects', async () => {
    const registry = new EntityRegistry();
    const seen = record();
    const refund: RemoteTool = { name: 'refund', inputSchema: { type: 'object' } };
    const idempotent: RemoteTool = {
      ...refund,
      name: 'set',
      annotations: { idempotentHint: true },
    };
    const session = new FakeSession([lookup, refund, idempotent]);
    const connection = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () => Promise.resolve(session),
    });
    await connection.start();

    expect(toolIds(registry)).toEqual([
      'mcp__crm__lookup_order',
      'mcp__crm__refund',
      'mcp__crm__set',
    ]);
    expect(seen.connected).toEqual([toolIds(registry)]);
    const tool = registry.resolve({ kind: 'tool', id: 'mcp__crm__lookup_order', version: null });
    expect(tool.description).toBe('Looks an order up.');
    expect(tool.locality).toEqual({ type: 'remote', protocol: 'mcp', url: server.url ?? '' });
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    expect(tool.retrySafe).toBe(true);
    const plain = registry.resolve({ kind: 'tool', id: 'mcp__crm__refund', version: null });
    expect(plain.retrySafe).toBe(false);
    expect(plain.description).toBe('');
    expect(registry.resolve({ kind: 'tool', id: 'mcp__crm__set', version: null }).retrySafe).toBe(
      true,
    );

    expect(await invoke(registry, 'mcp__crm__lookup_order', { id: 'a1' })).toEqual(
      textResult('ok'),
    );
    expect(await invoke(registry, 'mcp__crm__refund', 'not an object')).toEqual(textResult('ok'));
    expect(session.calls).toEqual([
      { name: 'lookup_order', args: { id: 'a1' } },
      { name: 'refund', args: {} },
    ]);

    await connection.stop();
    expect(toolIds(registry)).toEqual([]);
    expect(session.closed).toBe(true);
  });

  test('skips tools it cannot register safely', async () => {
    const registry = new EntityRegistry();
    registry.register(
      defineTool({
        id: 'mcp__crm__taken',
        description: 'Already there.',
        inputSchema: { type: 'object' },
        invoke: () => Promise.resolve(textResult('local')),
      }),
    );
    const seen = record();
    const schema = { type: 'object' };
    const connection = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () =>
        Promise.resolve(
          new FakeSession([
            { name: 'a b', inputSchema: schema },
            { name: 'a.b', inputSchema: schema },
            { name: 'taken', inputSchema: schema },
            { name: 'x'.repeat(80), inputSchema: schema },
            { name: 'no_schema' },
            { name: 'bad_schema', inputSchema: ['not', 'a', 'schema'] },
            { name: 'bigint_schema', inputSchema: { maximum: 10n } },
            { name: 'dangling_schema', inputSchema: { $ref: '#/$defs/missing' } },
          ]),
        ),
    });
    await connection.start();

    expect(toolIds(registry)).toEqual(['mcp__crm__a_b', 'mcp__crm__taken']);
    expect(seen.skipped).toEqual([
      { tool: 'a.b', reason: 'duplicate' },
      { tool: 'taken', reason: 'duplicate' },
      { tool: 'x'.repeat(80), reason: 'invalid-id' },
      { tool: 'no_schema', reason: 'no-input-schema' },
      { tool: 'bad_schema', reason: 'no-input-schema' },
      { tool: 'bigint_schema', reason: 'no-input-schema' },
      { tool: 'dangling_schema', reason: 'no-input-schema' },
    ]);
    expect(await invoke(registry, 'mcp__crm__taken')).toEqual(textResult('local'));
    await connection.stop();
    expect(toolIds(registry)).toEqual(['mcp__crm__taken']);
  });

  test('retries an unreachable server with growing delays until it connects', async () => {
    const registry = new EntityRegistry();
    const seen = record();
    let attempts = 0;
    const connection = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () => {
        attempts += 1;
        return attempts <= 3
          ? Promise.reject(new Error(`refused ${String(attempts)}`))
          : Promise.resolve(new FakeSession([lookup]));
      },
    });
    await connection.start();
    expect(toolIds(registry)).toEqual([]);
    expect(seen.unavailable).toEqual([{ reason: 'refused 1', retryInMs: 4 }]);

    await until(() => seen.connected.length === 1);
    expect(seen.unavailable.map((entry) => entry.retryInMs)).toEqual([4, 8, 10]);
    expect(toolIds(registry)).toEqual(['mcp__crm__lookup_order']);
    await connection.stop();
  });

  test('a failure while listing tools counts as unreachable', async () => {
    const registry = new EntityRegistry();
    const seen = record();
    const broken = new FakeSession([]);
    broken.listTools = () => Promise.reject(new Error('list failed'));
    const sessions = [broken, new FakeSession([lookup])];
    const connection = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () => Promise.resolve(sessions.shift() ?? new FakeSession([])),
    });
    await connection.start();
    expect(seen.unavailable).toEqual([{ reason: 'list failed', retryInMs: 4 }]);
    expect(broken.closed).toBe(true);
    await until(() => seen.connected.length === 1);
    await connection.stop();
  });

  test('does not retry a server whose configuration is unusable', async () => {
    const seen = record();
    const connection = new ServerConnection({
      server,
      backoff,
      registry: new EntityRegistry(),
      events: seen.events,
      open: () => Promise.reject(new McpConfigError('no command')),
    });
    await connection.start();
    await sleep(20);
    expect(seen.unavailable).toEqual([{ reason: 'no command', retryInMs: null }]);
    await connection.stop();
  });

  test('removes the tools of a server that drops and brings them back', async () => {
    const registry = new EntityRegistry();
    const seen = record();
    const first = new FakeSession([lookup]);
    const sessions = [first, new FakeSession([lookup])];
    const connection = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () => Promise.resolve(sessions.shift() ?? new FakeSession([])),
    });
    await connection.start();
    const stale = registry.resolve({ kind: 'tool', id: 'mcp__crm__lookup_order', version: null });

    first.drop();
    expect(toolIds(registry)).toEqual([]);
    expect(seen.unavailable).toHaveLength(1);
    expect(seen.unavailable[0]?.retryInMs).toBe(4);
    // A call that was already holding the tool gets an answer, not an exception.
    const late = await stale.invoke({}, callContext());
    expect(late.ok ? '' : late.error.code).toBe('unavailable');
    // A second close notification for the same session changes nothing.
    first.drop();
    expect(seen.unavailable).toHaveLength(1);

    await until(() => seen.connected.length === 2);
    expect(toolIds(registry)).toEqual(['mcp__crm__lookup_order']);
    await connection.stop();
  });

  test('maps call failures and treats a transport failure as a drop', async () => {
    const registry = new EntityRegistry();
    const seen = record();
    const failures: Record<string, Error> = {
      protocol: new ProtocolError(-32_602, 'bad arguments'),
      transport: new Error('fetch failed'),
    };
    const session = new FakeSession(
      [
        { name: 'protocol', inputSchema: { type: 'object' } },
        { name: 'transport', inputSchema: { type: 'object' } },
        { name: 'slow', inputSchema: { type: 'object' } },
      ],
      (name, _args, signal) =>
        name === 'slow'
          ? new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            })
          : Promise.reject(failures[name] ?? new Error('unexpected tool')),
    );
    const connection = new ServerConnection({
      server,
      backoff: { initialMs: 10_000, factor: 2, maxMs: 10_000 },
      registry,
      events: seen.events,
      open: () => Promise.resolve(session),
    });
    await connection.start();

    expect(await invoke(registry, 'mcp__crm__protocol')).toEqual({
      ok: false,
      error: { code: 'tool-error', message: 'bad arguments' },
    });
    const controller = new AbortController();
    const slow = registry
      .resolve({ kind: 'tool', id: 'mcp__crm__slow', version: null })
      .invoke({}, callContext(controller.signal));
    controller.abort();
    expect(await slow).toEqual({ ok: false, error: { code: 'cancelled', message: 'aborted' } });
    expect(toolIds(registry)).toHaveLength(3);

    const transport = registry.resolve({ kind: 'tool', id: 'mcp__crm__transport', version: null });
    expect(await transport.invoke({}, callContext())).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'fetch failed' },
    });
    expect(toolIds(registry)).toEqual([]);
    expect(session.closed).toBe(true);
    expect(seen.unavailable).toEqual([{ reason: 'fetch failed', retryInMs: 10_000 }]);
    await connection.stop();
  });

  test('stopping cancels a pending retry and a connection still being made', async () => {
    const seen = record();
    let attempts = 0;
    const failing = new ServerConnection({
      server,
      backoff,
      registry: new EntityRegistry(),
      events: seen.events,
      open: () => {
        attempts += 1;
        return Promise.reject(new Error('refused'));
      },
    });
    await failing.start();
    await failing.stop();
    await sleep(20);
    expect(attempts).toBe(1);

    const registry = new EntityRegistry();
    const late = new FakeSession([lookup]);
    let release: (session: McpSession) => void = () => undefined;
    const pending = new ServerConnection({
      server,
      backoff,
      registry,
      events: seen.events,
      open: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const started = pending.start();
    await pending.stop();
    release(late);
    await started;
    expect(late.closed).toBe(true);
    expect(toolIds(registry)).toEqual([]);
    expect(seen.connected).toEqual([]);
  });
});
