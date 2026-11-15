/** The process's stop requests, listened for only while the command waits on them. */

/** The signals that ask `yaah` to stop: Ctrl+C, a service manager, a closed terminal. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Resolves on the first stop request this process receives (SIGINT, SIGTERM or SIGHUP).
 *
 * The listeners are removed once one of the signals arrives or `signal` aborts, so a
 * later signal — a second Ctrl+C during a slow shutdown — gets Node's default behaviour
 * and ends the process. Once `signal` aborts the promise never resolves.
 */
export function interrupted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void) => {
    const stop = (): void => {
      release();
      resolve();
    };
    const release = (): void => {
      for (const name of STOP_SIGNALS) {
        process.removeListener(name, stop);
      }
      signal?.removeEventListener('abort', release);
    };
    if (signal?.aborted === true) {
      return;
    }
    for (const name of STOP_SIGNALS) {
      process.once(name, stop);
    }
    signal?.addEventListener('abort', release, { once: true });
  });
}
