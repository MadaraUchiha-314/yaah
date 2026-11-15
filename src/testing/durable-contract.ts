import type { DurableExecution } from '../app/durable/types.ts';
import type { StepHandlers } from '../harness/core/direct-runner.ts';
import { createMemoryPersistence } from '../harness/core/memory-persistence.ts';
import type { StepJournal } from '../harness/core/persistence.ts';
import type { RetryPolicy, RunLimits } from '../harness/core/step-runner.ts';
import type { ContractApi } from './contract-api.ts';

/** What a durable-execution mode is built from in the contract. */
export interface DurableContractDeps {
  readonly handlers: StepHandlers;
  readonly limits: RunLimits;
  readonly journal: StepJournal;
  /** A fast policy, so that the contract does not wait seconds between attempts. */
  readonly retry: RetryPolicy;
  /** Whether the step may be attempted again after a failure or an unknown outcome. */
  readonly isRetrySafe: (name: string, input: unknown) => boolean;
}

/** Builds the mode under test, and disposes of it. */
export type DurableFactory = (deps: DurableContractDeps) => Promise<DurableExecution>;

interface Recorder {
  readonly handlers: StepHandlers;
  readonly log: string[];
  llmFailures: { retryable: boolean }[];
  toolFailsOnce: boolean;
}

/** Step implementations that record what was asked of them and fail on request. */
function recorder(toolCalls: number): Recorder {
  const state: Recorder = {
    log: [],
    llmFailures: [],
    toolFailsOnce: false,
    handlers: {
      'conversation.accept': () => Promise.resolve({ accepted: 1 }),
      'context.build': () => Promise.resolve({ estimatedTokens: 1, compact: false }),
      'context.compact': () => Promise.resolve({ before: 0, after: 0 }),
      'llm.invoke': () => {
        state.log.push('llm');
        const failure = state.llmFailures.shift();
        if (failure !== undefined) {
          return Promise.reject(Object.assign(new Error('provider failed'), failure));
        }
        const first = state.log.filter((entry) => entry === 'llm-ok').length === 0;
        state.log.push('llm-ok');
        return Promise.resolve({
          toolCalls: first && toolCalls > 0 ? [{ id: 'c1', name: 'work', args: {} }] : [],
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        });
      },
      'tool.invoke': (ctx) => {
        state.log.push(ctx.outcomeUnknown ? 'tool-unknown' : 'tool');
        if (state.toolFailsOnce && !ctx.outcomeUnknown) {
          state.toolFailsOnce = false;
          return Promise.reject(new Error('worker lost'));
        }
        return Promise.resolve({ ok: !ctx.outcomeUnknown });
      },
      'task.transition': (_ctx, input) => {
        state.log.push(`status:${input.reason}`);
        return Promise.resolve(
          input.reason === 'turn-start'
            ? { state: 'working' as const, subState: null }
            : {
                state:
                  input.reason === 'cancel'
                    ? ('canceled' as const)
                    : input.reason === 'error'
                      ? ('failed' as const)
                      : ('completed' as const),
                subState: null,
              },
        );
      },
    },
  };
  return state;
}

const ITEM = { id: 'm1', kind: 'message', interrupt: false } as const;
const LIMITS: RunLimits = { maxIterations: 5, maxTaskTokens: 1000 };
const FAST: RetryPolicy = {
  initialIntervalMs: 1,
  backoffCoefficient: 2,
  maximumIntervalMs: 4,
  maximumAttempts: 4,
};

/** How long one contract test may take: its waits, plus starting the backend. */
const TEST_MS = 30_000;
/** How long a test waits for the backend to reach a state. */
const WAIT_MS = 20_000;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/**
 * The contract every durable-execution mode must keep: the same task, driven the same
 * way, behaves the same whether steps run in this process or as Temporal activities.
 *
 * @param uniqueTask Returns a task id not used before — a Temporal mode keeps history per id.
 */
export function durableContract(
  api: ContractApi,
  name: string,
  create: DurableFactory,
  uniqueTask: () => string,
): void {
  const { describe, expect } = api;
  // A durable backend may start a worker per test; give each the time its own waits allow.
  const test = (title: string, body: () => Promise<void>): void => {
    api.test(title, body, TEST_MS);
  };
  const build = (state: Recorder, retrySafeTools: boolean): Promise<DurableExecution> =>
    create({
      handlers: state.handlers,
      limits: LIMITS,
      journal: createMemoryPersistence().journal,
      retry: FAST,
      isRetrySafe: (step: string) => step !== 'tool.invoke' || retrySafeTools,
    });

  describe(`durable contract: ${name}`, () => {
    test('runs a delivered item through the loop to a terminal status', async () => {
      const state = recorder(1);
      const durable = await build(state, true);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:turn-complete'));
      expect(state.log).toEqual([
        'status:turn-start',
        'llm',
        'llm-ok',
        'tool',
        'llm',
        'llm-ok',
        'status:turn-complete',
      ]);
      await durable.close();
    });

    test('retries a step that fails with a retryable error, then carries on', async () => {
      const state = recorder(0);
      state.llmFailures = [{ retryable: true }, { retryable: true }];
      const durable = await build(state, true);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:turn-complete'));
      expect(state.log.filter((entry) => entry === 'llm').length).toBe(3);
      expect(state.log.at(-1)).toBe('status:turn-complete');
      await durable.close();
    });

    test('does not retry a step that fails with a non-retryable error: the task fails', async () => {
      const state = recorder(0);
      state.llmFailures = [{ retryable: false }];
      const durable = await build(state, true);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:error'));
      expect(state.log.filter((entry) => entry === 'llm').length).toBe(1);
      expect(state.log.at(-1)).toBe('status:error');
      await durable.close();
    });

    test('gives up after the configured number of attempts', async () => {
      const state = recorder(0);
      state.llmFailures = Array.from({ length: 10 }, () => ({ retryable: true }));
      const durable = await build(state, true);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:error'));
      expect(state.log.filter((entry) => entry === 'llm').length).toBe(FAST.maximumAttempts);
      await durable.close();
    });

    test('a tool that is not safe to retry is attempted once; the model is told the outcome is unknown', async () => {
      const state = recorder(1);
      state.toolFailsOnce = true;
      const durable = await build(state, false);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:turn-complete'));
      expect(state.log.filter((entry) => entry === 'tool').length).toBe(1);
      expect(state.log).toContain('tool-unknown');
      await durable.close();
    });

    test('a tool that is safe to retry is attempted again', async () => {
      const state = recorder(1);
      state.toolFailsOnce = true;
      const durable = await build(state, true);
      await durable.deliver(uniqueTask(), ITEM);
      await until(() => state.log.includes('status:turn-complete'));
      expect(state.log.filter((entry) => entry === 'tool').length).toBe(2);
      expect(state.log.includes('tool-unknown')).toBe(false);
      await durable.close();
    });

    test('cancel ends the task as canceled', async () => {
      const state = recorder(0);
      const durable = await build(state, true);
      const taskId = uniqueTask();
      await durable.recover([taskId]);
      await durable.cancel(taskId);
      await until(() => state.log.includes('status:cancel'));
      expect(state.log).toEqual(['status:cancel']);
      await durable.close();
    });
  });
}
