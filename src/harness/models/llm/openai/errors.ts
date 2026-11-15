/**
 * Turns whatever the OpenAI SDK throws into an {@link LlmError}, for both wire formats.
 *
 * Invariant: an error built here never carries text that came from upstream — no response
 * body, no SDK message, no `cause`. A provider echoes the key in some error bodies, so the
 * message is built from the HTTP status and a short error code only, and the code is
 * dropped unless it looks like an identifier and holds no secret.
 */
import { APIConnectionError, APIError, APIUserAbortError } from 'openai';

import { t } from '../../../../kernel/strings.ts';
import { LlmError } from '../types.ts';

/** Who a failure is attributed to, and which strings must never appear in it. */
export interface ErrorScope {
  /** The provider id: `openai`, or a compatible endpoint's id. */
  readonly provider: string;
  readonly model: string;
  /** Credentials in use for this provider. */
  readonly secrets: readonly string[];
}

const CODE = /^[\w.-]{1,64}$/u;
const HTTP_TIMEOUT = 408;
const HTTP_CONFLICT = 409;
const HTTP_RATE_LIMIT = 429;
const HTTP_SERVER_ERROR = 500;
/** Codes of a failure reported inside a stream that trying again can fix. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['server_error', 'rate_limit_exceeded']);

function safeCode(scope: ErrorScope, code: unknown): string | null {
  if (typeof code !== 'string' || !CODE.test(code)) {
    return null;
  }
  return scope.secrets.some((secret: string) => secret !== '' && code.includes(secret))
    ? null
    : code;
}

function retryableStatus(status: number): boolean {
  return (
    status === HTTP_TIMEOUT ||
    status === HTTP_CONFLICT ||
    status === HTTP_RATE_LIMIT ||
    status >= HTTP_SERVER_ERROR
  );
}

function names(scope: ErrorScope): { provider: string; model: string } {
  return { provider: scope.provider, model: scope.model };
}

/** The call was cancelled through its `AbortSignal`. Not retryable. */
export function abortedError(scope: ErrorScope): LlmError {
  return new LlmError(scope.provider, scope.model, false, t('error.llm.aborted', names(scope)));
}

/**
 * The provider reported a failure inside the stream (a `response.failed` or `error`
 * event). Retryable for a server fault, a rate limit, or when no code says otherwise.
 */
export function streamFailure(scope: ErrorScope, code: unknown): LlmError {
  const safe = safeCode(scope, code);
  const retryable = typeof code !== 'string' || RETRYABLE_CODES.has(code);
  const message = t('error.llm.failed', { ...names(scope), code: safe ?? t('error.llm.no-code') });
  return new LlmError(scope.provider, scope.model, retryable, message);
}

/** The stream ended before the provider said the response was complete. Retryable. */
export function truncatedError(scope: ErrorScope): LlmError {
  return new LlmError(scope.provider, scope.model, true, t('error.llm.truncated', names(scope)));
}

/** The model produced tool-call arguments that are not JSON. Retryable: it may do better. */
export function argumentsError(scope: ErrorScope, tool: string): LlmError {
  const message = t('error.llm.tool-arguments', { ...names(scope), name: tool });
  return new LlmError(scope.provider, scope.model, true, message);
}

/**
 * Maps a thrown value to an {@link LlmError}.
 *
 * - an aborted `signal`, or the SDK's abort error, is not retryable, whatever was thrown;
 * - otherwise an `LlmError` is returned as is;
 * - HTTP 408, 409, 429 and 5xx are retryable; every other status (400, 401, 403, 404,
 *   422, …) is not;
 * - a connection failure, a timeout, and anything unrecognised while reading the stream
 *   are retryable.
 */
export function toLlmError(scope: ErrorScope, error: unknown, signal: AbortSignal): LlmError {
  // Checked first: an aborted stream just ends, which would otherwise read as truncated.
  if (signal.aborted || error instanceof APIUserAbortError) {
    return abortedError(scope);
  }
  if (error instanceof LlmError) {
    return error;
  }
  if (error instanceof APIError && !(error instanceof APIConnectionError)) {
    const status: unknown = error.status;
    if (typeof status !== 'number') {
      return streamFailure(scope, error.code);
    }
    const code = safeCode(scope, error.code) ?? t('error.llm.no-code');
    const message = t('error.llm.http', { ...names(scope), status, code });
    return new LlmError(scope.provider, scope.model, retryableStatus(status), message);
  }
  return new LlmError(scope.provider, scope.model, true, t('error.llm.connection', names(scope)));
}
