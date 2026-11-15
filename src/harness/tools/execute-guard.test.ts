import { describe, expect, test } from 'bun:test';

import { EntityRegistry } from '../../kernel/registry.ts';
import { executeToolCall } from './execute.ts';
import { defineTool, textResult } from './types.ts';

const context = { taskId: 't1', key: 't1/0/tool.invoke/c1', signal: new AbortController().signal };
const call = { id: 'c1', name: 'lookup', args: { id: 'a1' } };

/** A registry holding one tool, and how often that tool ran. */
function counting(): { registry: EntityRegistry; runs: () => number } {
  let runs = 0;
  const registry = new EntityRegistry();
  registry.register(
    defineTool({
      id: 'lookup',
      description: 'Look an order up.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      invoke: () => {
        runs += 1;
        return Promise.resolve(textResult('ran'));
      },
    }),
  );
  return { registry, runs: () => runs };
}

describe('executeToolCall with a guard', () => {
  test('a guard that returns null lets the call run, and sees the call and its step', async () => {
    const { registry, runs } = counting();
    const seen: unknown[] = [];
    const result = await executeToolCall(registry, call, context, {
      guard: (asked, about) => {
        seen.push(asked, about.taskId, about.key);
        return Promise.resolve(null);
      },
    });
    expect(result.ok).toBe(true);
    expect(runs()).toBe(1);
    expect(seen).toEqual([call, 't1', 't1/0/tool.invoke/c1']);
  });

  test('a refusal is the result and the tool does not run', async () => {
    const { registry, runs } = counting();
    const result = await executeToolCall(registry, call, context, {
      guard: () => Promise.resolve({ code: 'denied', message: 'not today' }),
    });
    expect(result).toEqual({ ok: false, error: { code: 'denied', message: 'not today' } });
    expect(runs()).toBe(0);
  });

  test('a guard that throws refuses the call', async () => {
    const { registry, runs } = counting();
    const result = await executeToolCall(registry, call, context, {
      guard: () => Promise.reject(new Error('guard broke')),
    });
    expect(result).toEqual({ ok: false, error: { code: 'failed', message: 'guard broke' } });
    expect(runs()).toBe(0);
  });

  test('the guard is not asked about a call that would be refused anyway', async () => {
    const { registry } = counting();
    let asked = 0;
    const guard = (): Promise<null> => {
      asked += 1;
      return Promise.resolve(null);
    };
    await executeToolCall(registry, { ...call, args: {} }, context, { guard });
    await executeToolCall(registry, { ...call, name: 'absent' }, context, { guard });
    expect(asked).toBe(0);
  });
});
