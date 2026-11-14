/**
 * Turns whatever the OpenAI SDK throws during a Decisions call into a
 * {@link SystemOneError}. The classification — what is retryable, and that no text from
 * upstream reaches the message — is the LLM provider's, reused unchanged.
 */
import { t } from '../../../../kernel/strings.ts';
import type { ErrorScope } from '../../llm/openai/errors.ts';
import { toLlmError } from '../../llm/openai/errors.ts';
import { SystemOneError } from '../types.ts';

/**
 * The provider's answers do not line up with the questions: a different count, a
 * different type, or a choice that was not offered. Retryable: the next call may do better.
 */
export function mismatchError(scope: ErrorScope): SystemOneError {
  const message = t('error.system-one.mismatch', { provider: scope.provider, model: scope.model });
  return new SystemOneError(scope.provider, scope.model, true, message);
}

/**
 * Maps a thrown value to a {@link SystemOneError}.
 *
 * An aborted `signal` is not retryable, whatever was thrown. HTTP 408, 409, 429 and 5xx
 * and connection failures are retryable; every other status is not.
 */
export function toSystemOneError(
  scope: ErrorScope,
  error: unknown,
  signal: AbortSignal,
): SystemOneError {
  if (error instanceof SystemOneError && !signal.aborted) {
    return error;
  }
  const mapped = toLlmError(scope, error, signal);
  return new SystemOneError(mapped.provider, mapped.model, mapped.retryable, mapped.message);
}
