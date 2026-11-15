/**
 * A failure of the executor that belongs to the request, not to the task. A message for
 * a task that is alive and well can fail on its way to the inbox; the task's run goes on,
 * so the task must not be marked failed. The SDK has no way for an executor to fail a
 * request, so the executor notes the failure in the request's call context, and the
 * request handler, which holds the same context, turns it into an A2A error.
 */
import { A2AError } from '@a2a-js/sdk/errors';
import type { ServerCallContext } from '@a2a-js/sdk/server';

import { t } from '../../kernel/strings.ts';

const FAILURE_KEY = 'yaah.request-failure';

/** Notes that the request of `context` failed, for the reason `cause` (already redacted). */
export function recordFailure(context: ServerCallContext, cause: string): void {
  context.state.set(FAILURE_KEY, cause);
}

/** The A2A error for a failure noted for `context`, if there was one. */
export function failureOf(context: ServerCallContext): A2AError | undefined {
  const cause = context.state.get(FAILURE_KEY);
  return typeof cause === 'string'
    ? new A2AError({ message: t('server.message-not-taken', { cause }) })
    : undefined;
}
