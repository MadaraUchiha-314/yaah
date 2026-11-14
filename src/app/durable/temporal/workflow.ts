/**
 * The task workflow: the core loop, run by Temporal.
 *
 * This file is the entry of the workflow bundle. It may import only code that is
 * deterministic and free of I/O — the loop, its types, and Temporal's workflow API.
 * Everything with an effect happens in an activity, whose result Temporal records; on
 * replay a recorded activity is not run again, which is why the non-determinism of a
 * model or a tool is harmless here.
 */
import {
  ActivityFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import { runTask } from '../../../harness/core/loop.ts';
import type {
  InboxItemRef,
  RunPosition,
  StepInput,
  StepName,
  StepOutput,
  StepRunner,
  TransitionResult,
} from '../../../harness/core/step-runner.ts';
import { TaskCancelledError, TurnInterruptedError } from '../../../harness/core/step-runner.ts';
import type { Json } from '../../../kernel/json.ts';
import type { TaskActivities, TaskWorkflowInput } from './protocol.ts';
import { CANCEL_SIGNAL, INBOX_SIGNAL, NON_RETRYABLE } from './protocol.ts';

const inboxSignal = defineSignal<[InboxItemRef]>(INBOX_SIGNAL);
const cancelSignal = defineSignal(CANCEL_SIGNAL);

/** How long one attempt of a step may take, and how soon a silent worker is noticed. */
const STEP_TIMEOUT = '10 minutes';
const HEARTBEAT_TIMEOUT = '30 seconds';

/** Step outputs and inputs are plain JSON by contract; these casts cross that boundary. */
function toJson(value: unknown): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain data by contract
  return value as Json;
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the type
function fromJson<T>(value: Json): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain data by contract
  return value as T;
}

/** A {@link StepRunner} whose steps are Temporal activities. */
class TemporalRunner implements StepRunner {
  readonly taskId: string;
  readonly limits: TaskWorkflowInput['limits'];
  readonly queue: InboxItemRef[];
  readonly seen: Set<string>;
  cancelled = false;
  #scope: CancellationScope | null = null;
  #interrupted = false;
  readonly #root: CancellationScope;
  readonly #retried: TaskActivities;
  readonly #once: TaskActivities;
  readonly #local: TaskActivities;
  readonly #input: TaskWorkflowInput;

  constructor(input: TaskWorkflowInput, root: CancellationScope) {
    this.#input = input;
    this.#root = root;
    this.taskId = input.taskId;
    this.limits = input.limits;
    this.queue = [...(input.resume?.queued ?? [])];
    this.seen = new Set(input.resume?.seen);
    const timeouts = {
      startToCloseTimeout: STEP_TIMEOUT,
      heartbeatTimeout: HEARTBEAT_TIMEOUT,
    } as const;
    this.#retried = proxyActivities<TaskActivities>({
      ...timeouts,
      retry: {
        initialInterval: input.retry.initialIntervalMs,
        backoffCoefficient: input.retry.backoffCoefficient,
        maximumInterval: input.retry.maximumIntervalMs,
        maximumAttempts: input.retry.maximumAttempts,
        nonRetryableErrorTypes: [NON_RETRYABLE],
      },
    });
    this.#once = proxyActivities<TaskActivities>({ ...timeouts, retry: { maximumAttempts: 1 } });
    this.#local = proxyLocalActivities<TaskActivities>({ startToCloseTimeout: '10 seconds' });
  }

  /** A signal brought an inbox item. An interrupting one cancels the open scope. */
  deliver(item: InboxItemRef): void {
    if (this.seen.has(item.id) || this.queue.some((queued) => queued.id === item.id)) {
      return;
    }
    this.queue.push(item);
    if (item.interrupt && this.#scope !== null) {
      this.#interrupted = true;
      this.#scope.cancel();
    }
  }

  /** A signal cancelled the task: everything but the shielded final step stops. */
  cancel(): void {
    this.cancelled = true;
    this.#root.cancel();
  }

  async step<N extends StepName>(
    name: N,
    key: string,
    input: StepInput<N>,
  ): Promise<StepOutput<N>> {
    try {
      const request = {
        name,
        taskId: this.taskId,
        key,
        input: toJson(input),
        outcomeUnknown: false,
      };
      const safe = await this.#local.isRetrySafe({ name, input: request.input });
      if (safe) {
        return fromJson<StepOutput<N>>(await this.#retried.performStep(request));
      }
      try {
        return fromJson<StepOutput<N>>(await this.#once.performStep(request));
      } catch (error) {
        if (!(error instanceof ActivityFailure) || isCancellation(error)) {
          throw error;
        }
        // The one attempt was lost or failed with its effect possibly done: record that
        // the outcome is unknown rather than run it a second time.
        const unknown = { ...request, outcomeUnknown: true };
        return fromJson<StepOutput<N>>(await this.#retried.performStep(unknown));
      }
    } catch (error) {
      throw this.#translate(error);
    }
  }

  async nextInboxItem(): Promise<InboxItemRef> {
    try {
      await condition(() => this.queue.length > 0);
    } catch (error) {
      throw this.#translate(error);
    }
    const [item] = this.queue.splice(0, 1);
    if (item === undefined) {
      throw new TaskCancelledError();
    }
    this.seen.add(item.id);
    return item;
  }

  drainInbox(): Promise<readonly InboxItemRef[]> {
    const items = this.queue.splice(0);
    for (const item of items) {
      this.seen.add(item.id);
    }
    return Promise.resolve(items);
  }

  async interruptible<T>(body: () => Promise<T>): Promise<T> {
    const scope = new CancellationScope();
    this.#scope = scope;
    this.#interrupted = false;
    try {
      const result = await scope.run(body);
      return result;
    } catch (error) {
      throw this.#interrupted && !this.cancelled ? new TurnInterruptedError() : error;
    } finally {
      this.#scope = null;
    }
  }

  shielded<T>(body: () => Promise<T>): Promise<T> {
    return CancellationScope.nonCancellable(body);
  }

  /** Starts a fresh run of the same task when Temporal says the history is getting long. */
  async checkpoint(position: RunPosition): Promise<void> {
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof taskWorkflow>({
        ...this.#input,
        resume: { position, queued: [...this.queue], seen: [...this.seen] },
      });
    }
  }

  /** Turns Temporal's cancellation into the loop's own two errors. */
  #translate(error: unknown): unknown {
    if (!isCancellation(error)) {
      return error;
    }
    return this.cancelled ? new TaskCancelledError() : new TurnInterruptedError();
  }
}

/** Runs one task from its first inbox item to a terminal state. */
export async function taskWorkflow(input: TaskWorkflowInput): Promise<TransitionResult> {
  const root = new CancellationScope();
  const runner = new TemporalRunner(input, root);
  setHandler(inboxSignal, (item: InboxItemRef) => {
    runner.deliver(item);
  });
  setHandler(cancelSignal, () => {
    runner.cancel();
  });
  const outcome = await root.run(() => runTask(runner, input.resume?.position));
  return outcome;
}
