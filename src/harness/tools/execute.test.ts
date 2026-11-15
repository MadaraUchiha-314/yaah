import { describe, expect, test } from 'bun:test';

import { EntityRegistry } from '../../kernel/registry.ts';
import { executeToolCall, isUsableSchema, validateToolArgs } from './execute.ts';
import { defineTool, textResult } from './types.ts';

const context = { taskId: 't1', key: 't1/0/tool.invoke/c1', signal: new AbortController().signal };

const lookup = defineTool({
  id: 'lookup',
  description: 'Look an order up.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  invoke: (args) => Promise.resolve(textResult(`order ${JSON.stringify(args)}`)),
});

function registryWith(...tools: ReturnType<typeof defineTool>[]): EntityRegistry {
  const registry = new EntityRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

describe('validateToolArgs', () => {
  test('accepts arguments that match the schema', () => {
    expect(validateToolArgs(lookup, { id: 'A-1' })).toBeNull();
  });

  test('names what is wrong with arguments that do not', () => {
    expect(validateToolArgs(lookup, { id: 7 })?.code).toBe('invalid-arguments');
    expect(validateToolArgs(lookup, {})?.code).toBe('invalid-arguments');
    expect(validateToolArgs(lookup, { id: 'A', extra: true })?.code).toBe('invalid-arguments');
    expect(validateToolArgs(lookup, 'not an object')?.code).toBe('invalid-arguments');
  });
});

describe('executeToolCall', () => {
  test('runs a registered tool with valid arguments', async () => {
    const result = await executeToolCall(
      registryWith(lookup),
      { id: 'c1', name: 'lookup', args: { id: 'A-1' } },
      context,
    );
    expect(result).toEqual(textResult('order {"id":"A-1"}'));
  });

  test('refuses a tool that is not registered, without throwing', async () => {
    const result = await executeToolCall(
      registryWith(),
      { id: 'c1', name: 'rm_rf', args: {} },
      context,
    );
    expect(result.ok ? '' : result.error.code).toBe('not-found');
  });

  test('refuses a tool outside the allowed set', async () => {
    const result = await executeToolCall(
      registryWith(lookup),
      { id: 'c1', name: 'lookup', args: { id: 'A-1' } },
      context,
      { allowed: new Set(['other']) },
    );
    expect(result.ok ? '' : result.error.code).toBe('not-found');
  });

  test('refuses invalid arguments before the tool runs', async () => {
    let ran = false;
    const guarded = defineTool({
      ...lookup,
      id: 'guarded',
      description: 'x',
      invoke: () => {
        ran = true;
        return Promise.resolve(textResult('ran'));
      },
    });
    const result = await executeToolCall(
      registryWith(guarded),
      { id: 'c1', name: 'guarded', args: { id: 7 } },
      context,
    );
    expect(result.ok ? '' : result.error.code).toBe('invalid-arguments');
    expect(ran).toBe(false);
  });

  test('a tool that declares no input schema is never called', async () => {
    let ran = false;
    const bare = defineTool({
      ...lookup,
      id: 'bare',
      invoke: () => {
        ran = true;
        return Promise.resolve(textResult('ran'));
      },
    });
    // What a plugin written without types could register.
    Reflect.deleteProperty(bare, 'inputSchema');
    const result = await executeToolCall(
      registryWith(bare),
      { id: 'c1', name: 'bare', args: {} },
      context,
    );
    expect(result.ok ? '' : result.error.message).toContain('declares no input schema');
    expect(ran).toBe(false);
  });

  test('refuses a call whose schema cannot be used, without throwing', async () => {
    let ran = false;
    const dangling = defineTool({
      id: 'dangling',
      description: 'x',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } },
      invoke: () => {
        ran = true;
        return Promise.resolve(textResult('ran'));
      },
    });
    const result = await executeToolCall(
      registryWith(dangling),
      { id: 'c1', name: 'dangling', args: { a: 1 } },
      context,
    );
    expect(result.ok ? '' : result.error.code).toBe('invalid-arguments');
    expect(result.ok ? '' : result.error.message).toContain('cannot be checked');
    expect(ran).toBe(false);
    expect(isUsableSchema(dangling.inputSchema)).toBe(true);
    expect(isUsableSchema({ $ref: '#/$defs/missing' })).toBe(false);
  });

  test('turns a thrown error into a failed result', async () => {
    const broken = defineTool({
      id: 'broken',
      description: 'x',
      inputSchema: { type: 'object' },
      invoke: () => Promise.reject(new Error('backend down')),
    });
    const result = await executeToolCall(
      registryWith(broken),
      { id: 'c1', name: 'broken', args: {} },
      context,
    );
    expect(result).toEqual({ ok: false, error: { code: 'failed', message: 'backend down' } });
  });

  test('times out a tool that does not answer, and aborts it', async () => {
    let aborted = false;
    const slow = defineTool({
      id: 'slow',
      description: 'x',
      inputSchema: { type: 'object' },
      invoke: (_args, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    const result = await executeToolCall(
      registryWith(slow),
      { id: 'c1', name: 'slow', args: {} },
      context,
      { timeoutMs: 20 },
    );
    expect(result.ok ? '' : result.error.code).toBe('timeout');
    expect(aborted).toBe(true);
  });
});
