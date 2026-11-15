/**
 * The caller of one HTTP request, as the SDK's request handler sees it. Nobody is
 * authenticated; what the caller carries is a signal that aborts when its connection
 * closes, so the executor stops forwarding a stream nobody reads any more. The SDK has no
 * such signal of its own: it writes to a closed response until the executor finishes.
 */
import type { RequestContext, User } from '@a2a-js/sdk/server';

/** An unauthenticated caller whose connection may close. */
export class ConnectedCaller implements User {
  /** Aborts when the response is closed — sent in full, or the client went away. */
  readonly closed: AbortSignal;

  constructor(closed: AbortSignal) {
    this.closed = closed;
  }

  get isAuthenticated(): boolean {
    return false;
  }

  get userName(): string {
    return '';
  }
}

/** What {@link connectedCaller} needs of an HTTP request: its response. */
export interface ClosableRequest {
  readonly res?: { once(event: 'close', listener: () => void): unknown } | undefined;
}

/** Builds the caller of `request`: the SDK's `userBuilder`. */
export function connectedCaller(request: ClosableRequest): Promise<User> {
  const closed = new AbortController();
  request.res?.once('close', () => {
    closed.abort();
  });
  return Promise.resolve(new ConnectedCaller(closed.signal));
}

/** The signal that aborts when the caller of `request` goes away, if it has one. */
export function callerClosed(request: RequestContext): AbortSignal | undefined {
  const { user } = request.context;
  return user instanceof ConnectedCaller ? user.closed : undefined;
}
