/**
 * The activities of the task workflow: the step implementations, run by a Temporal
 * worker. One generic activity performs any step, so the workflow needs no knowledge of
 * what a step does.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';

import type { StepHandlers } from '../../../harness/core/direct-runner.ts';
import type { StepInput, StepName, StepOutput } from '../../../harness/core/step-runner.ts';
import { isRetryable } from '../../../harness/core/step-runner.ts';
import type { Json } from '../../../kernel/json.ts';
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

async function perform<N extends StepName>(
  handlers: StepHandlers,
  name: N,
  request: StepActivityInput,
  heartbeatMs: number,
): Promise<StepOutput<N>> {
  const context = Context.current();
  const beat = setInterval(() => {
    context.heartbeat();
  }, heartbeatMs);
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
    if (context.cancellationSignal.aborted || isRetryable(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw ApplicationFailure.nonRetryable(message, NON_RETRYABLE);
  } finally {
    clearInterval(beat);
  }
}

/** Builds the activities over the step implementations. */
export function createActivities(
  handlers: StepHandlers,
  isRetrySafe: (name: StepName, input: unknown) => boolean,
  heartbeatMs: number = HEARTBEAT_MS,
): TaskActivities {
  return {
    performStep: async (request: StepActivityInput): Promise<Json> =>
      toJson(await perform(handlers, request.name, request, heartbeatMs)),
    isRetrySafe: (request: { readonly name: StepName; readonly input: Json }): Promise<boolean> =>
      Promise.resolve(isRetrySafe(request.name, request.input)),
  };
}
