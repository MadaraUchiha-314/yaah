import { describe, expect, test } from 'bun:test';

import type { Json } from '../../kernel/json.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import type { ToolResult } from '../core/types.ts';
import type { ToolCallContext } from '../tools/types.ts';
import { defineTool, errorResult, textResult } from '../tools/types.ts';
import { mcpToolHook } from './mcp-hook.ts';

const event = {
  taskId: 't1',
  key: 't1/3/tool',
  callId: 'c1',
  args: { id: 'b2' },
  tool: 'mcp__crm__refund',
};

interface Seen {
  args: Json;
  ctx: ToolCallContext | undefined;
}

/** A hook over a policy tool that answers with `answer`. */
function hookOver(
  answer: (signal: AbortSignal) => Promise<ToolResult> | ToolResult,
  timeoutMs = 1000,
) {
  const registry = new EntityRegistry();
  const seen: Seen = { args: null, ctx: undefined };
  registry.register(
    defineTool({
      id: 'mcp__policy__check',
      description: 'Decides.',
      inputSchema: { type: 'object' },
      invoke: (args, ctx) => {
        seen.args = args;
        seen.ctx = ctx;
        return Promise.resolve().then(() => answer(ctx.signal));
      },
    }),
  );
  const run = mcpToolHook({ registry, timeoutMs }, 'tool.before', {
    server: 'policy',
    tool: 'check',
  });
  return { run, seen };
}

describe('mcpToolHook', () => {
  test('calls the tool with the event and reads an allow from JSON text', async () => {
    const { run, seen } = hookOver(() => textResult('{"decision":"allow","reason":"fine"}'));
    expect(await run(event)).toEqual({ decision: 'allow' });
    expect(seen.args).toEqual({ event: 'tool.before', ...event });
    expect(seen.ctx?.taskId).toBe('t1');
    expect(seen.ctx?.key).toBe('t1/3/tool');
  });

  test('reads a deny, with its reason, from structured content', async () => {
    const { run } = hookOver(() => ({
      ok: true,
      content: [],
      structured: { decision: 'deny', reason: 'refunds need a supervisor' },
    }));
    expect(await run(event)).toEqual({ decision: 'deny', reason: 'refunds need a supervisor' });
  });

  test('a deny without a reason is still a deny', async () => {
    const { run } = hookOver(() => textResult('{"decision":"deny"}'));
    expect(await run(event)).toEqual({ decision: 'deny', reason: '' });
  });

  test('an event without a task or a step is passed as it is', async () => {
    const { run, seen } = hookOver(() => textResult('{"decision":"allow"}'));
    await run({ taskId: null, contextId: 'ctx', text: 'hello' });
    expect(seen.ctx?.taskId).toBe('');
    expect(seen.ctx?.key).toBe('');
  });

  const malformed: readonly (readonly [string, ToolResult])[] = [
    ['text that is not JSON', textResult('sure, go ahead')],
    ['JSON without a decision', textResult('{"allow":true}')],
    ['an unknown decision', textResult('{"decision":"maybe"}')],
    ['a reason that is not a string', textResult('{"decision":"allow","reason":1}')],
    ['no content at all', { ok: true, content: [] }],
    [
      'content that is not text',
      { ok: true, content: [{ type: 'data', mediaType: 'x/y', data: 1 }] },
    ],
    ['structured content of another shape', { ok: true, content: [], structured: ['allow'] }],
  ];
  for (const [what, result] of malformed) {
    test(`${what} denies`, async () => {
      const { run } = hookOver(() => result);
      const verdict = await run(event);
      expect(verdict.decision).toBe('deny');
      expect(verdict.decision === 'deny' ? verdict.reason : '').toContain('no usable decision');
    });
  }

  test('an error result denies with the error', async () => {
    const { run } = hookOver(() => errorResult('tool-error', 'database down'));
    expect(await run(event)).toEqual({
      decision: 'deny',
      reason: 'the policy tool mcp__policy__check failed: database down',
    });
  });

  test('a tool that throws denies', async () => {
    const { run } = hookOver(() => {
      throw new Error('socket closed');
    });
    const verdict = await run(event);
    expect(verdict.decision === 'deny' ? verdict.reason : '').toContain('socket closed');
    const { run: other } = hookOver(() => {
      // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal -- a tool may throw anything
      throw 'plain';
    });
    expect((await other(event)).decision).toBe('deny');
  });

  test('no answer in time denies, and the call is aborted', async () => {
    let aborted = false;
    const { run } = hookOver(
      (signal) =>
        new Promise<ToolResult>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      20,
    );
    const verdict = await run(event);
    expect(verdict.decision === 'deny' ? verdict.reason : '').toContain(
      'did not answer within 20 ms',
    );
    expect(aborted).toBe(true);
  });

  test('a tool that is not registered — its server is down — denies', async () => {
    const run = mcpToolHook({ registry: new EntityRegistry(), timeoutMs: 10 }, 'tool.before', {
      server: 'policy',
      tool: 'check',
    });
    expect(await run(event)).toEqual({
      decision: 'deny',
      reason: 'the policy tool mcp__policy__check is not available',
    });
  });
});
