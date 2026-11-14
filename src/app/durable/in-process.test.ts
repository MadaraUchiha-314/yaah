import { describe, expect, test } from 'bun:test';

import { createMemoryPersistence } from '../../harness/core/memory-persistence.ts';
import type { StepHandlers } from '../../harness/core/direct-runner.ts';
import { InProcessDurable } from './in-process.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function handlers(overrides: Partial<StepHandlers> = {}): StepHandlers {
  const transitions: string[] = [];
  return {
    'conversation.accept': () => Promise.resolve({ accepted: 1 }),
    'context.build': () => Promise.resolve({ estimatedTokens: 1, compact: false }),
    'context.compact': () => Promise.resolve({ before: 0, after: 0 }),
    'llm.invoke': () =>
      Promise.resolve({
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      }),
    'tool.invoke': () => Promise.resolve({ ok: true }),
    'task.transition': (_ctx, input) => {
      transitions.push(input.reason);
      return Promise.resolve(
        input.reason === 'turn-complete'
          ? { state: 'completed' as const, subState: null }
          : { state: 'working' as const, subState: null },
      );
    },
    ...overrides,
  };
}

const item = { id: 'm1', kind: 'message', interrupt: false } as const;
const limits = { maxIterations: 5, maxTaskTokens: 1000 };

describe('InProcessDurable', () => {
  test('has no dashboard: there is no Temporal in this mode', () => {
    const durable = new InProcessDurable({
      handlers: handlers(),
      limits,
      journal: createMemoryPersistence().journal,
    });
    expect(durable.mode).toBe('none');
    expect(durable.dashboard()).toBeNull();
    expect(durable.taskUrl()).toBeNull();
  });

  test('starts a run on first delivery and forgets it when the task ends', async () => {
    const durable = new InProcessDurable({
      handlers: handlers(),
      limits,
      journal: createMemoryPersistence().journal,
    });
    await durable.deliver('t1', item);
    expect(durable.active).toBe(1);
    await sleep(10);
    expect(durable.active).toBe(0);
  });

  test('close abandons waiting runs without recording anything', async () => {
    const reasons: string[] = [];
    const durable = new InProcessDurable({
      handlers: handlers({
        'task.transition': (_ctx, input) => {
          reasons.push(input.reason);
          return Promise.resolve({ state: 'working', subState: null });
        },
      }),
      limits,
      journal: createMemoryPersistence().journal,
      onError: () => {
        reasons.push('error reported');
      },
    });
    await durable.recover(['t1', 't2']);
    expect(durable.active).toBe(2);
    await durable.close();
    expect(durable.active).toBe(0);
    expect(reasons).toEqual([]);
  });

  test('reports a run that ends with an error the loop could not record', async () => {
    const reported: unknown[] = [];
    const durable = new InProcessDurable({
      handlers: handlers({ 'task.transition': () => Promise.reject(new Error('store is gone')) }),
      limits,
      journal: createMemoryPersistence().journal,
      onError: (_taskId, error) => {
        reported.push(error);
      },
    });
    await durable.deliver('t1', item);
    await sleep(10);
    expect(reported.length).toBe(1);
    expect(durable.active).toBe(0);
  });

  test('cancel reaches a task that has no run yet', async () => {
    const reasons: string[] = [];
    const durable = new InProcessDurable({
      handlers: handlers({
        'task.transition': (_ctx, input) => {
          reasons.push(input.reason);
          return Promise.resolve({ state: 'canceled', subState: null });
        },
      }),
      limits,
      journal: createMemoryPersistence().journal,
    });
    await durable.cancel('t9');
    await sleep(10);
    expect(reasons).toEqual(['cancel']);
  });
});
