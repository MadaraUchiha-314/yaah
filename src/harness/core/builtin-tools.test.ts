import { describe, expect, test } from 'bun:test';

import type { Json } from '../../kernel/json.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import { executeToolCall } from '../tools/execute.ts';
import { createBuiltinTools } from './builtin-tools.ts';
import { createMemoryPersistence } from './memory-persistence.ts';
import type { ToolResult } from './types.ts';

function setup(stateSchemas?: ReadonlyMap<string, Record<string, Json>>): {
  run: (name: string, args: Json, step?: number) => Promise<ToolResult>;
  persistence: ReturnType<typeof createMemoryPersistence>;
} {
  const persistence = createMemoryPersistence();
  const registry = new EntityRegistry();
  for (const tool of createBuiltinTools({
    ...persistence,
    ...(stateSchemas === undefined ? {} : { stateSchemas }),
  })) {
    registry.register(tool);
  }
  let counter = 0;
  const run = (name: string, args: Json, step?: number): Promise<ToolResult> => {
    counter += 1;
    return executeToolCall(
      registry,
      { id: `c${String(counter)}`, name, args },
      {
        taskId: 't1',
        key: `t1/${String(step ?? counter)}/tool.invoke/`,
        signal: new AbortController().signal,
      },
    );
  };
  return { run, persistence };
}

const code = (result: ToolResult): string => (result.ok ? 'ok' : result.error.code);

describe('plan tools', () => {
  test('plan_set stores a valid plan and bumps the revision', async () => {
    const { run, persistence } = setup();
    const steps = [
      { name: 'a', description: 'first' },
      { name: 'b', description: 'second', dependsOn: ['a'] },
    ];
    expect(code(await run('plan_set', { steps }))).toBe('ok');
    expect(code(await run('plan_set', { steps }))).toBe('ok');
    const plan = await persistence.plan.load('t1');
    expect(plan?.revision).toBe(2);
    expect(plan?.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
  });

  test('plan_set returns the reason when the plan has a cycle', async () => {
    const { run, persistence } = setup();
    const result = await run('plan_set', {
      steps: [
        { name: 'a', description: 'x', dependsOn: ['b'] },
        { name: 'b', description: 'y', dependsOn: ['a'] },
      ],
    });
    expect(code(result)).toBe('invalid-plan');
    expect(result.ok ? '' : result.error.message).toContain('cycle');
    expect(await persistence.plan.load('t1')).toBeUndefined();
  });

  test('plan_set returns the reason for a dependency on an unknown step', async () => {
    const { run } = setup();
    const result = await run('plan_set', {
      steps: [{ name: 'a', description: 'x', dependsOn: ['ghost'] }],
    });
    expect(result.ok ? '' : result.error.message).toContain('ghost');
  });

  test('plan_update_step changes status and output of one step', async () => {
    const { run, persistence } = setup();
    await run('plan_set', { steps: [{ name: 'a', description: 'first' }] });
    expect(code(await run('plan_update_step', { name: 'a', status: 'done', output: 'ok' }))).toBe(
      'ok',
    );
    expect((await persistence.plan.load('t1'))?.steps[0]).toMatchObject({
      status: 'done',
      output: 'ok',
    });
  });

  test('plan_update_step refuses an unknown step and a missing plan', async () => {
    const { run } = setup();
    expect(code(await run('plan_update_step', { name: 'a', status: 'done' }))).toBe('no-plan');
    await run('plan_set', { steps: [{ name: 'a', description: 'first' }] });
    expect(code(await run('plan_update_step', { name: 'zzz', status: 'done' }))).toBe(
      'unknown-step',
    );
  });
});

describe('state tools', () => {
  test('state_set then state_get round-trips a JSON value', async () => {
    const { run } = setup();
    expect(
      code(await run('state_set', { name: 'order', value: { id: 'A-1', lines: [1, 2] } })),
    ).toBe('ok');
    const read = await run('state_get', { name: 'order' });
    expect(read.ok ? read.structured : null).toEqual({ id: 'A-1', lines: [1, 2] });
  });

  test('state_get reports a name that was never set', async () => {
    const { run } = setup();
    expect(code(await run('state_get', { name: 'nope' }))).toBe('not-found');
  });

  test('state_set refuses the reserved prefix', async () => {
    const { run } = setup();
    expect(code(await run('state_set', { name: 'yaah.plan-snapshot', value: 'x' }))).toBe(
      'reserved',
    );
  });

  test('state_set rejects a value that does not match the schema of its prefix', async () => {
    const schemas = new Map([
      ['order.', { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }],
    ]);
    const { run, persistence } = setup(schemas);
    expect(code(await run('state_set', { name: 'order.current', value: { id: 7 } }))).toBe(
      'invalid-value',
    );
    expect(await persistence.state.get('t1', 'order.current')).toBeUndefined();
    expect(code(await run('state_set', { name: 'order.current', value: { id: 'A-1' } }))).toBe(
      'ok',
    );
    expect(code(await run('state_set', { name: 'other', value: 7 }))).toBe('ok');
  });
});

describe('ask_user as an ordinary tool', () => {
  test('answers that only one question may be asked at a time', async () => {
    const { run } = setup();
    expect(code(await run('ask_user', { question: 'Second?' }))).toBe('one-at-a-time');
  });
});
