import { describe, expect, test } from 'bun:test';

import type { HookName } from './service.ts';
import { BLOCKING_HOOKS, HOOK_NAMES, Hooks, globToRegExp } from './service.ts';

const call = { taskId: 't1', key: 't1/1/tool', callId: 'c1', args: { id: 'a1' } };

describe('globToRegExp', () => {
  test('* matches any run of characters, ? exactly one, the rest literally', () => {
    expect(globToRegExp('mcp__crm__*').test('mcp__crm__refund')).toBe(true);
    expect(globToRegExp('mcp__crm__*').test('mcp__docs__refund')).toBe(false);
    expect(globToRegExp('mcp__crm__*').test('x_mcp__crm__refund')).toBe(false);
    expect(globToRegExp('tool?').test('tool1')).toBe(true);
    expect(globToRegExp('tool?').test('tool12')).toBe(false);
    expect(globToRegExp('a.b(c)').test('a.b(c)')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('Hooks', () => {
  test('names every lifecycle point, three of them blocking', () => {
    expect(HOOK_NAMES).toHaveLength(7);
    expect([...BLOCKING_HOOKS].toSorted()).toEqual([
      'agent.before',
      'message.received',
      'tool.before',
    ]);
  });

  test('runs the hooks of a point in registration order', async () => {
    const hooks = new Hooks();
    const order: string[] = [];
    hooks.register('llm.before', { run: () => void order.push('first') });
    hooks.register('llm.before', {
      run: async () => {
        await Promise.resolve();
        order.push('second');
      },
    });
    hooks.register('llm.after', { run: () => void order.push('other point') });
    expect(await hooks.dispatch('llm.before', { taskId: 't1', key: 'k' })).toEqual({
      decision: 'allow',
    });
    expect(order).toEqual(['first', 'second']);
  });

  test('at a blocking point the first deny blocks and later hooks do not run', async () => {
    const hooks = new Hooks();
    const ran: string[] = [];
    hooks.register('tool.before', { run: () => ({ decision: 'allow' }) });
    hooks.register('tool.before', { run: () => ({ decision: 'deny', reason: 'not on Sundays' }) });
    hooks.register('tool.before', { run: () => void ran.push('third') });
    expect(await hooks.dispatch('tool.before', { ...call, tool: 'refund' })).toEqual({
      decision: 'deny',
      reason: 'not on Sundays',
    });
    expect(ran).toEqual([]);
  });

  test('a hook that throws at a blocking point denies and is reported', async () => {
    const failures: [HookName, unknown][] = [];
    const hooks = new Hooks((event, error) => {
      failures.push([event, error]);
    });
    hooks.register('message.received', {
      run: () => {
        throw new Error('policy offline');
      },
    });
    const verdict = await hooks.dispatch('message.received', {
      taskId: null,
      contextId: 'c',
      text: 'hi',
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.decision === 'deny' ? verdict.reason : '').toContain('policy offline');
    expect(failures.map(([event]) => event)).toEqual(['message.received']);
  });

  test('at a point that does not block, a deny and a throw change nothing', async () => {
    const failures: unknown[] = [];
    const hooks = new Hooks((_event, error) => {
      failures.push(error);
    });
    const ran: string[] = [];
    hooks.register('tool.after', { run: () => ({ decision: 'deny', reason: 'too late' }) });
    hooks.register('tool.after', {
      run: () => {
        // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal -- a hook may throw anything
        throw 'not an error object';
      },
    });
    hooks.register('tool.after', { run: () => void ran.push('last') });
    expect(await hooks.dispatch('tool.after', { ...call, tool: 'refund', ok: true })).toEqual({
      decision: 'allow',
    });
    expect(ran).toEqual(['last']);
    expect(failures).toEqual(['not an error object']);
  });

  test('match filters on the tool id, and on the agent id for agent.before', async () => {
    const hooks = new Hooks();
    const seen: string[] = [];
    hooks.register('tool.before', {
      match: 'mcp__crm__*',
      run: (event) => void seen.push(event.tool),
    });
    hooks.register('agent.before', {
      match: 'billing',
      run: () => ({ decision: 'deny', reason: 'no billing agent' }),
    });
    hooks.register('task.transition', {
      match: 'ignored',
      run: (event) => void seen.push(event.state),
    });
    await hooks.dispatch('tool.before', { ...call, tool: 'mcp__crm__refund' });
    await hooks.dispatch('tool.before', { ...call, tool: 'update_plan' });
    expect((await hooks.dispatch('agent.before', { ...call, agent: 'billing' })).decision).toBe(
      'deny',
    );
    expect((await hooks.dispatch('agent.before', { ...call, agent: 'shipping' })).decision).toBe(
      'allow',
    );
    await hooks.dispatch('task.transition', {
      taskId: 't1',
      key: 'k',
      reason: 'turn-complete',
      state: 'completed',
      subState: null,
    });
    expect(seen).toEqual(['mcp__crm__refund', 'completed']);
  });

  test('the disposer removes the hook, and is safe to call twice', async () => {
    const hooks = new Hooks();
    const remove = hooks.register('tool.before', {
      run: () => ({ decision: 'deny', reason: 'x' }),
    });
    remove();
    remove();
    expect((await hooks.dispatch('tool.before', { ...call, tool: 'refund' })).decision).toBe(
      'allow',
    );
  });

  test('a thrown non-error at a blocking point is worded into the reason', async () => {
    const hooks = new Hooks();
    hooks.register('agent.before', {
      run: () => {
        // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal -- a hook may throw anything
        throw 'boom';
      },
    });
    const verdict = await hooks.dispatch('agent.before', { ...call, agent: 'a' });
    expect(verdict).toEqual({ decision: 'deny', reason: 'a hook failed: boom' });
  });
});
