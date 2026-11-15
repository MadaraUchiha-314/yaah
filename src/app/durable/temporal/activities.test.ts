import { describe, expect, test } from 'bun:test';
import { ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';

import type { StepHandlers } from '../../../harness/core/direct-runner.ts';
import { YaahError } from '../../../kernel/errors.ts';
import { REDACTED, Redactor } from '../../../kernel/redactor.ts';
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
const SECRET = 'sk-synthetic-credential-0123456789';
const redactor = new Redactor([SECRET]);
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
      redactor,
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
      redactor,
      5,
    );
    await environment.run(activities.performStep, request);
    expect(beats).toBeGreaterThan(1);
  });

  test('an error that trying again cannot fix is marked non-retryable for Temporal', async () => {
    const activities = createActivities(
      handlers(() => Promise.reject(new YaahError('limit.tokens', 'budget spent'))),
      () => true,
      redactor,
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
      redactor,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(error instanceof ApplicationFailure ? error.nonRetryable : true).toBe(false);
    expect(error instanceof Error ? error.message : '').toBe('rate limited');
  });
});

describe('a failing step leaves no credential in its failure', () => {
  /** Everything of `error` Temporal records: message, stack and type, down the cause chain. */
  function recorded(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message, current.stack ?? '', current.name);
      current = current.cause;
    }
    return parts.join('\n');
  }

  test('a non-retryable error is redacted, and stays non-retryable', async () => {
    const leaky = new YaahError(
      'limit.tokens',
      `budget spent for ${SECRET}`,
      new Error(`upstream said ${SECRET}`),
    );
    const activities = createActivities(
      handlers(() => Promise.reject(leaky)),
      () => true,
      redactor,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(recorded(error)).not.toContain(SECRET);
    expect(recorded(error)).toContain(REDACTED);
    expect(error instanceof ApplicationFailure ? [error.type, error.nonRetryable] : []).toEqual([
      NON_RETRYABLE,
      true,
    ]);
  });

  test('a retryable error is redacted, and stays retryable under its own type', async () => {
    const leaky = Object.assign(new TypeError(`fetch failed: Bearer ${SECRET}`), {
      retryable: true,
    });
    const activities = createActivities(
      handlers(() => Promise.reject(leaky)),
      () => true,
      redactor,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(recorded(error)).not.toContain(SECRET);
    expect(error instanceof ApplicationFailure ? [error.type, error.nonRetryable] : []).toEqual([
      'TypeError',
      false,
    ]);
  });

  test('a failure raised as one keeps its own type and flag, redacted', async () => {
    const leaky = ApplicationFailure.nonRetryable(`denied ${SECRET}`, 'Denied');
    const activities = createActivities(
      handlers(() => Promise.reject(leaky)),
      () => true,
      redactor,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(recorded(error)).not.toContain(SECRET);
    expect(error instanceof ApplicationFailure ? [error.type, error.nonRetryable] : []).toEqual([
      'Denied',
      true,
    ]);
  });

  test('a thrown value that is not an error is redacted too', async () => {
    const activities = createActivities(
      // oxlint-disable-next-line prefer-promise-reject-errors -- what careless code throws
      handlers(() => Promise.reject(`raw ${SECRET}`)),
      () => true,
      redactor,
    );
    const error = await failure(() =>
      new MockActivityEnvironment().run(activities.performStep, request),
    );
    expect(recorded(error)).not.toContain(SECRET);
  });
});

describe('a cancelled step', () => {
  function waitingThen(fail: (signal: AbortSignal) => Error): StepHandlers {
    return handlers(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(fail(ctx.signal));
          });
        }),
    );
  }

  test('stops as cancelled, which Temporal records without detail', async () => {
    const environment = new MockActivityEnvironment();
    const activities = createActivities(
      waitingThen((signal) =>
        signal.reason instanceof Error ? signal.reason : new Error('not a cancellation'),
      ),
      () => true,
      redactor,
    );
    const pending = failure(() => environment.run(activities.performStep, request));
    environment.cancel();
    expect(await pending).toBeInstanceOf(CancelledFailure);
  });

  test('that fails some other way on its way out is redacted', async () => {
    const environment = new MockActivityEnvironment();
    const activities = createActivities(
      waitingThen(() => new Error(`closing ${SECRET}`)),
      () => true,
      redactor,
    );
    const pending = failure(() => environment.run(activities.performStep, request));
    environment.cancel();
    const error = await pending;
    expect(error instanceof Error ? error.message : SECRET).not.toContain(SECRET);
  });
});

describe('isRetrySafe activity', () => {
  test('answers from the function it was built with', async () => {
    const activities = createActivities(handlers(idle), (name) => name !== 'tool.invoke', redactor);
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
