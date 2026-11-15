/**
 * The activities of the task workflow: the step implementations, run by a Temporal
 * worker. One generic activity performs any step, so the workflow needs no knowledge of
 * what a step does.
 */
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';

import type { StepHandlers } from '../../../harness/core/direct-runner.ts';
import type { StepInput, StepName, StepOutput } from '../../../harness/core/step-runner.ts';
import { isRetryable } from '../../../harness/core/step-runner.ts';
import type { Json } from '../../../kernel/json.ts';
import type { Redactor } from '../../../kernel/redactor.ts';
import type { StepActivityInput, TaskActivities } from './protocol.ts';
import { NON_RETRYABLE } from './protocol.ts';

/** How often a running step tells Temporal it is alive. */
const HEARTBEAT_MS = 5000;

/** Step inputs and outputs are plain JSON by contract; these casts cross that boundary. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the type
function fromJson<T>(value: Json): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain data by contract
  return value as T;
}
function toJson(value: unknown): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain data by contract
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** How deep a cause chain is copied; a longer (or circular) one is cut there. */
const MAX_CAUSES = 8;

/** A copy of `error` and its causes with every registered secret removed. */
function redactedError(error: unknown, redactor: Redactor, depth: number): Error {
  const message = redactor.redactString(error instanceof Error ? error.message : String(error));
  const copy = new Error(message);
  copy.name = error instanceof Error ? error.name : 'Error';
  copy.stack = error instanceof Error ? redactor.redactString(error.stack ?? '') : '';
  if (error instanceof Error && error.cause !== undefined && depth < MAX_CAUSES) {
    copy.cause = redactedError(error.cause, redactor, depth + 1);
  }
  return copy;
}

/**
 * The failure a step's error leaves the activity as: its message, stack and causes
 * redacted, since Temporal writes all three to the workflow history and the worker logs
 * them. It keeps the classification — an error worth retrying stays retryable under its
 * own type; any other is non-retryable as {@link NON_RETRYABLE}.
 */
function stepFailure(error: unknown, redactor: Redactor): ApplicationFailure {
  const copy = redactedError(error, redactor, 0);
  let nonRetryable = !isRetryable(error);
  let type = nonRetryable ? NON_RETRYABLE : copy.name;
  if (error instanceof ApplicationFailure) {
    // Raised as a Temporal failure on purpose: its own flag and type stand.
    nonRetryable = error.nonRetryable === true;
    type = error.type ?? copy.name;
  }
  const failure = ApplicationFailure.create({
    message: copy.message,
    type,
    nonRetryable,
    ...(copy.cause instanceof Error ? { cause: copy.cause } : {}),
  });
  failure.stack = copy.stack ?? '';
  return failure;
}

/** Whether `error` is how a cancelled activity stops; Temporal records no detail of it. */
function isCancellation(error: unknown): boolean {
  return (
    error instanceof CancelledFailure || (error instanceof Error && error.name === 'AbortError')
  );
}

async function perform<N extends StepName>(
  handlers: StepHandlers,
  name: N,
  request: StepActivityInput,
  deps: { readonly redactor: Redactor; readonly heartbeatMs: number },
): Promise<StepOutput<N>> {
  const context = Context.current();
  const beat = setInterval(() => {
    context.heartbeat();
  }, deps.heartbeatMs);
  try {
    const output = await handlers[name](
      {
        taskId: request.taskId,
        key: request.key,
        signal: context.cancellationSignal,
        outcomeUnknown: request.outcomeUnknown,
      },
      fromJson<StepInput<N>>(request.input),
    );
    return output;
  } catch (error) {
    if (context.cancellationSignal.aborted && isCancellation(error)) {
      throw error;
    }
    throw stepFailure(error, deps.redactor);
  } finally {
    clearInterval(beat);
  }
}

/**
 * Builds the activities over the step implementations.
 *
 * @param redactor Applied to every failure before it leaves an activity.
 */
export function createActivities(
  handlers: StepHandlers,
  isRetrySafe: (name: StepName, input: unknown) => boolean,
  redactor: Redactor,
  heartbeatMs: number = HEARTBEAT_MS,
): TaskActivities {
  const deps = { redactor, heartbeatMs };
  return {
    performStep: async (request: StepActivityInput): Promise<Json> =>
      toJson(await perform(handlers, request.name, request, deps)),
    isRetrySafe: (request: { readonly name: StepName; readonly input: Json }): Promise<boolean> =>
      Promise.resolve(isRetrySafe(request.name, request.input)),
  };
}
