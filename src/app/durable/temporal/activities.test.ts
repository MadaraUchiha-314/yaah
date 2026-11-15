import { describe, expect, test } from 'bun:test';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';

import type { StepHandlers } from '../../../harness/core/direct-runner.ts';
import { YaahError } from '../../../kernel/errors.ts';
import { createActivities } from './activities.ts';
import { cloudDashboardUrl, localDashboardUrl } from './connection.ts';
import { NON_RETRYABLE, workflowIdOf } from './protocol.ts';

const idle = (): Promise<never> => Promise.reject(new Error('not used in this test'));

function handlers(llm: StepHandlers['llm.invoke']): StepHandlers {
  return {
    'conversation.accept': idle,
    'context.build': idle,
    'context.compact': idle,
    'llm.invoke': llm,
    'tool.invoke': idle,
    'task.transition': idle,
  };
}

const request = {
  name: 'llm.invoke',
  taskId: 't1',
  key: 't1/0/llm.invoke/',
  input: {},
  outcomeUnknown: false,
} as const;
const usage = { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 };

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('performStep', () => {
  test('runs the step with the task, the key and the flags it was given, and returns plain JSON', async () => {
    const seen: unknown[] = [];
    const activities = createActivities(
      handlers((ctx) => {
        seen.push([ctx.taskId, ctx.key, ctx.outcomeUnknown, ctx.signal.aborted]);
        return Promise.resolve({ toolCalls: [], usage });
      }),
      () => true,
    );
    const output = await new MockActivityEnvironment().run(activities.performStep, request);
    expect(output).toEqual({ toolCalls: [], usage });
    expect(seen).toEqual([['t1', 't1/0/llm.invoke/', false, false]]);
  });

  test('heartbeats while a step is running, so a dead worker is noticed', async () => {
    const environment = new MockActivityEnvironment();
    let beats = 0;
    environment.on('heartbeat', () => {
      beats += 1;
    });
    const activities = createActivities(
      handlers(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 40);
        });
        return { toolCalls: [], usage };
      }),
      () => true,
      5,
    );
    await environment.run(activities.performStep, request);
    expect(beats).toBeGreaterThan(1);
  });

  test('an error that trying again cannot fix is marked non-retryable for Temporal', async () => {
    const activities = createActivities(
      handlers(() => Promise.reject(new YaahError('limit.tokens', 'budget spent'))),
      () => true,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error instanceof ApplicationFailure ? [error.type, error.nonRetryable] : []).toEqual([
      NON_RETRYABLE,
      true,
    ]);
  });

  test('an error that may pass is left for Temporal to retry', async () => {
    const activities = createActivities(
      handlers(() => Promise.reject(Object.assign(new Error('rate limited'), { retryable: true }))),
      () => true,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect(error instanceof Error ? error.message : '').toBe('rate limited');
  });
});

describe('isRetrySafe activity', () => {
  test('answers from the function it was built with', async () => {
    const activities = createActivities(handlers(idle), (name) => name !== 'tool.invoke');
    expect(await activities.isRetrySafe({ name: 'tool.invoke', input: {} })).toBe(false);
    expect(await activities.isRetrySafe({ name: 'llm.invoke', input: {} })).toBe(true);
  });
});

describe('addresses', () => {
  test('a task maps to one workflow id', () => {
    expect(workflowIdOf('abc')).toBe('yaah-abc');
  });

  test('the dashboard address is the namespace page, cloud or local', () => {
    expect(cloudDashboardUrl('yaah.gtebu')).toBe('https://cloud.temporal.io/namespaces/yaah.gtebu');
    expect(localDashboardUrl(8233, 'default')).toBe('http://127.0.0.1:8233/namespaces/default');
  });
});
