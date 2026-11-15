/**
 * Turns whatever an OpenAI speech call throws or reports into a {@link SpeechError}. The
 * classification — what is retryable, and that no text from upstream reaches the
 * message — is the LLM provider's, reused unchanged.
 */
import { t } from '../../../kernel/strings.ts';
import type { ErrorScope } from '../llm/openai/errors.ts';
import { streamFailure, toLlmError } from '../llm/openai/errors.ts';
import type { LlmError } from '../llm/types.ts';
import { SpeechError } from './types.ts';

function fromLlm(error: LlmError): SpeechError {
  return new SpeechError(error.provider, error.model, error.retryable, error.message);
}

/**
 * Maps a thrown value to a {@link SpeechError}.
 *
 * An aborted `signal` is not retryable, whatever was thrown. HTTP 408, 409, 429 and 5xx
 * and connection failures are retryable; every other status is not.
 */
export function toSpeechError(scope: ErrorScope, error: unknown, signal: AbortSignal): SpeechError {
  if (error instanceof SpeechError && !signal.aborted) {
    return error;
  }
  return fromLlm(toLlmError(scope, error, signal));
}

/**
 * The provider reported a failure inside a stream or over a socket. Retryable for a
 * server fault, a rate limit, or when no code says otherwise.
 */
export function reportedFailure(scope: ErrorScope, code: unknown): SpeechError {
  return fromLlm(streamFailure(scope, code));
}

/** The stream or the socket ended before the provider said it was done. Retryable. */
export function endedEarly(scope: ErrorScope): SpeechError {
  const message = t('error.speech.ended-early', { provider: scope.provider, model: scope.model });
  return new SpeechError(scope.provider, scope.model, true, message);
}

/** The recording is in a format the provider does not take. Not retryable. */
export function unsupportedAudio(scope: ErrorScope, mediaType: string): SpeechError {
  const message = t('error.speech.unsupported-audio', {
    provider: scope.provider,
    model: scope.model,
    mediaType,
  });
  return new SpeechError(scope.provider, scope.model, false, message);
}
