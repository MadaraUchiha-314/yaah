import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';

import type { StepHandlers } from './direct-runner.ts';
import { DirectRunner } from './direct-runner.ts';

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const unused = (): Promise<never> => Promise.reject(new Error('not used in this test'));
const limits = { maxIterations: 10, maxTaskTokens: 1_000_000 };

function handlers(llm: StepHandlers['llm.invoke']): StepHandlers {
  return {
    'conversation.accept': unused,
    'context.build': unused,
    'context.compact': unused,
    'llm.invoke': llm,
    'tool.invoke': unused,
    'task.transition': unused,
  };
}

describe('the abort listeners of a step (critic 1, #5)', () => {
  test('completed steps leave no listener on the task signal', async () => {
    const signals = new Set<AbortSignal>();
    const runner = new DirectRunner(
      't1',
      handlers((ctx) => {
        signals.add(ctx.signal);
        return Promise.resolve({ toolCalls: [], usage });
      }),
      limits,
    );
    for (let index = 0; index < 100; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- steps of one task run in order
      await runner.step('llm.invoke', `t1/${String(index)}/llm.invoke/`, {});
    }
    const [signal] = signals;
    expect(signals.size).toBe(1);
    expect(signal === undefined ? -1 : getEventListeners(signal, 'abort').length).toBe(0);
  });

  test('a step retried after a wait leaves no listener either', async () => {
    const signals = new Set<AbortSignal>();
    let attempts = 0;
    const runner = new DirectRunner(
      't1',
      handlers((ctx) => {
        signals.add(ctx.signal);
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('busy'))
          : Promise.resolve({ toolCalls: [], usage });
      }),
      limits,
      {
        retry: {
          initialIntervalMs: 1,
          backoffCoefficient: 1,
          maximumIntervalMs: 1,
          maximumAttempts: 3,
        },
      },
    );
    expect(await runner.step('llm.invoke', 't1/0/llm.invoke/', {})).toEqual({
      toolCalls: [],
      usage,
    });
    expect(attempts).toBe(2);
    const [signal] = signals;
    expect(signal === undefined ? -1 : getEventListeners(signal, 'abort').length).toBe(0);
  });

  test('a cancelled step still stops at once', async () => {
    const runner = new DirectRunner(
      't1',
      handlers(
        () =>
          new Promise(() => {
            // Never answers, and ignores its signal.
          }),
      ),
      limits,
    );
    const pending = runner
      .step('llm.invoke', 't1/0/llm.invoke/', {})
      .catch((error: unknown) => error);
    runner.cancel();
    expect(await pending).toBeInstanceOf(Error);
  });
});
