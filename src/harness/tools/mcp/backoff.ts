/** Exponential backoff for reconnecting to an MCP server. */

/** How long to wait between connection attempts. All values are milliseconds. */
export interface BackoffConfig {
  /** The wait after the first failure. */
  readonly initialMs: number;
  /** What the wait is multiplied by after each further failure. */
  readonly factor: number;
  /** The longest wait. */
  readonly maxMs: number;
}

/** One second, doubling, at most one minute. */
export const DEFAULT_BACKOFF: BackoffConfig = { initialMs: 1000, factor: 2, maxMs: 60_000 };

/** Completes a partial backoff configuration from {@link DEFAULT_BACKOFF}. */
export function resolveBackoff(partial: Partial<BackoffConfig> = {}): BackoffConfig {
  return {
    initialMs: partial.initialMs ?? DEFAULT_BACKOFF.initialMs,
    factor: partial.factor ?? DEFAULT_BACKOFF.factor,
    maxMs: partial.maxMs ?? DEFAULT_BACKOFF.maxMs,
  };
}

/**
 * The wait before the next attempt, after `failures` consecutive failures have already
 * been waited for (0 for the first failure). Never more than `backoff.maxMs`.
 */
export function backoffDelay(failures: number, backoff: BackoffConfig): number {
  return Math.min(backoff.maxMs, backoff.initialMs * backoff.factor ** failures);
}
