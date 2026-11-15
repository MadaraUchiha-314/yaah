import { describe, expect, test } from 'bun:test';

import type { StepHandlers } from './direct-runner.ts';
import type { StepCall, StepMiddleware } from './step-middleware.ts';
import { withMiddleware } from './step-middleware.ts';

function handlers(): StepHandlers {
  return {
    'conversation.accept': () => Promise.resolve({ accepted: 1 }),
    'context.build': () => Promise.resolve({ estimatedTokens: 3, compact: false }),
    'context.compact': () => Promise.resolve({ before: 2, after: 1 }),
    'llm.invoke': () =>
      Promise.resolve({
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
      }),
    'tool.invoke': () => Promise.reject(new Error('tool broke')),
    'task.transition': () => Promise.resolve({ state: 'working', subState: null }),
  };
}

const CTX = {
  taskId: 't1',
  key: 't1/0/x/',
  signal: new AbortController().signal,
  outcomeUnknown: false,
};

describe('withMiddleware', () => {
  test('passes every step through each middleware, the first added outermost', async () => {
    const seen: string[] = [];
    const tag =
      (label: string): StepMiddleware =>
      async <T>(call: StepCall, next: () => Promise<T>): Promise<T> => {
        seen.push(`${label}>${call.name}`);
        const result = await next();
        seen.push(`${label}<${call.name}`);
        return result;
      };
    const wrapped = withMiddleware(handlers(), new Set([tag('a'), tag('b')]));
    expect(await wrapped['conversation.accept'](CTX, { itemIds: ['i'] })).toEqual({ accepted: 1 });
    expect(seen).toEqual([
      'a>conversation.accept',
      'b>conversation.accept',
      'b<conversation.accept',
      'a<conversation.accept',
    ]);
    await wrapped['context.build'](CTX, {});
    await wrapped['context.compact'](CTX, {});
    await wrapped['llm.invoke'](CTX, {});
    await wrapped['task.transition'](CTX, { reason: 'turn-start' });
    expect(seen.filter((entry) => entry.startsWith('a>'))).toHaveLength(5);
  });

  test('a middleware added later applies, and a failure passes through unchanged', async () => {
    const middlewares = new Set<StepMiddleware>();
    const wrapped = withMiddleware(handlers(), middlewares);
    const calls: StepCall[] = [];
    middlewares.add(<T>(call: StepCall, next: () => Promise<T>): Promise<T> => {
      calls.push(call);
      return next();
    });
    const call = { id: 'c1', name: 'x', args: {} };
    const outcome = await wrapped['tool.invoke'](CTX, { call }).catch((error: unknown) => error);
    expect(outcome).toEqual(new Error('tool broke'));
    expect(calls).toEqual([{ name: 'tool.invoke', taskId: 't1', key: 't1/0/x/', input: { call } }]);
  });
});
