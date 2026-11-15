/**
 * What stands between the network and the A2A handlers. There is no authentication in
 * this work item, so these checks limit what an unidentified caller can do: which browser
 * origins may call, how large a request may be, and how much one caller may ask for.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { t } from '../../kernel/strings.ts';

/** The header the HTTP layer sets to tell the executor who is calling. Never trusted from a client. */
export const CALLER_HEADER = 'x-yaah-caller';

/** Limits applied to every request. */
export interface GuardLimits {
  readonly maxParts: number;
  readonly maxPartBytes: number;
  readonly maxOpenTasksPerCaller: number;
  readonly maxRequestsPerMinute: number;
}

/** Where the listener is bound. */
export interface ListenerAddress {
  /** The bound host as configured: a name, an IPv4 address or a bare IPv6 address. */
  readonly host: string;
  readonly port: number;
}

/** What the guards need to know about the harness. */
export interface GuardDeps {
  readonly limits: GuardLimits;
  /** Origins allowed besides the server's own. */
  readonly allowedOrigins: readonly string[];
  /** Where the listener is bound; undefined until it is. */
  readonly listener?: (() => ListenerAddress | undefined) | undefined;
  /** Whether to believe `X-Forwarded-For`. */
  readonly trustProxy: boolean;
  /** How many open tasks `caller` has. */
  readonly openTasks: (caller: string) => number;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: (() => number) | undefined;
}

const MINUTE_MS = 60_000;

function reject(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

/** What {@link callerKey} reads of a request. */
export interface CallerSource {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/**
 * The key the per-caller limits count against: the remote address, since nobody is
 * identified. Behind a trusted proxy it is the last `X-Forwarded-For` entry — the one
 * the proxy appended for the address it saw. The entries before it are whatever the
 * client chose to send.
 */
export function callerKey(request: CallerSource, trustProxy: boolean): string {
  const forwarded = request.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((hop: string) => hop.trim())
    .filter((hop: string) => hop !== '');
  const nearest = hops.at(-1);
  if (trustProxy && nearest !== undefined) {
    return nearest;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * Recent accepted request times per caller, over a sliding minute. A refused request is
 * not recorded, so a caller never has more stamps than the limit and a flood costs the
 * same per request as a trickle. Callers gone quiet are forgotten.
 */
export class RequestRate {
  readonly #recent = new Map<string, number[]>();
  #swept = 0;

  /** How many callers are remembered. */
  get size(): number {
    return this.#recent.size;
  }

  /** How many request times are stored for `caller`. */
  stored(caller: string): number {
    return this.#recent.get(caller)?.length ?? 0;
  }

  /**
   * Counts a request of `caller` at `now` against `limit` requests a minute. Returns
   * whether it is within the limit; only then is it recorded.
   */
  hit(caller: string, now: number, limit: number): boolean {
    const since = now - MINUTE_MS;
    if (now - this.#swept >= MINUTE_MS) {
      this.#swept = now;
      for (const [key, stamps] of this.#recent) {
        if (stamps.every((stamp: number) => stamp <= since)) {
          this.#recent.delete(key);
        }
      }
    }
    const stamps = this.#recent.get(caller) ?? [];
    // Stamps are in time order: the ones that left the minute are at the front.
    const kept = stamps.findIndex((stamp: number) => stamp > since);
    stamps.splice(0, kept === -1 ? stamps.length : kept);
    this.#recent.set(caller, stamps);
    if (stamps.length >= limit) {
      return false;
    }
    stamps.push(now);
    return true;
  }
}

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);

/** A host that is an IP literal, which no DNS answer can rebind. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/u.test(host) || host.startsWith('[');
}

/** The `Host` values naming the listener itself: its bound host and, on loopback, every loopback name. */
function ownHosts(address: ListenerAddress): string[] {
  const bound = address.host.includes(':') ? `[${address.host}]` : address.host;
  const names = LOOPBACK_HOSTS.includes(bound) ? LOOPBACK_HOSTS : [bound];
  return names.map((name: string) => `${name}:${String(address.port)}`);
}

/**
 * Whether `host` (a request's `Host`) names this listener or an allowed origin. A host
 * taken from the request alone proves nothing: a page whose name was rebound to this
 * address sends its own name. A wildcard bind cannot list the machine's addresses, so
 * there an IP literal is accepted too.
 */
function knownHost(host: string, deps: GuardDeps): boolean {
  const address = deps.listener?.();
  if (address === undefined) {
    return true;
  }
  return (
    ownHosts(address).includes(host) ||
    deps.allowedOrigins.some((origin: string) => URL.parse(origin)?.host === host) ||
    (WILDCARD_HOSTS.has(address.host) && isIpLiteral(host))
  );
}

/**
 * Rejects a request whose `Host` is not this listener's, and a browser request from an
 * origin that is neither the server's own nor allowed. A request without an `Origin`
 * header — any non-browser client — passes the origin check: this guard exists to stop a
 * web page the user happens to visit, or one whose name was rebound to this address, from
 * driving a local harness.
 */
export function originGuard(deps: GuardDeps): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const host = request.headers.host ?? '';
    if (!knownHost(host, deps)) {
      reject(response, 403, -32_600, t('server.host-rejected', { host }));
      return;
    }
    const { origin } = request.headers;
    if (origin === undefined) {
      next();
      return;
    }
    // The Host is now known to be this listener's, so the origin it implies is too.
    const own = `${request.protocol}://${host}`;
    if (origin !== own && !deps.allowedOrigins.includes(origin)) {
      reject(response, 403, -32_600, t('server.origin-rejected', { origin }));
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, A2A-Version, A2A-Extensions');
    response.setHeader('Access-Control-Expose-Headers', 'A2A-Extensions');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

/** The message a request body sends, whichever binding it uses. */
function messageOf(body: unknown): Readonly<Record<string, unknown>> | null {
  const fields = record(body);
  const params = record(fields['params']);
  const message = 'message' in params ? params['message'] : fields['message'];
  return typeof message === 'object' && message !== null ? record(message) : null;
}

function tooLarge(part: unknown, limit: number): boolean {
  return JSON.stringify(part).length > limit;
}

/**
 * Stamps the caller key on the request and enforces the per-request and per-caller
 * limits, before any task is created and before any model is called.
 */
export function limitGuard(deps: GuardDeps): RequestHandler {
  const { limits } = deps;
  const now = deps.now ?? Date.now;
  const rate = new RequestRate();
  return (request: Request, response: Response, next: NextFunction): void => {
    const caller = callerKey(request, deps.trustProxy);
    // Overwrites whatever the client sent: only this layer names the caller.
    request.headers[CALLER_HEADER] = caller;
    if (!rate.hit(caller, now(), limits.maxRequestsPerMinute)) {
      reject(
        response,
        429,
        -32_000,
        t('server.limit.rate', { limit: limits.maxRequestsPerMinute }),
      );
      return;
    }
    const message = messageOf(request.body);
    if (message === null) {
      next();
      return;
    }
    const parts = Array.isArray(message['parts']) ? message['parts'] : [];
    if (parts.length > limits.maxParts) {
      reject(response, 413, -32_602, t('server.limit.parts', { limit: limits.maxParts }));
      return;
    }
    if (parts.some((part: unknown) => tooLarge(part, limits.maxPartBytes))) {
      reject(response, 413, -32_602, t('server.limit.part-size', { limit: limits.maxPartBytes }));
      return;
    }
    const createsTask = typeof message['taskId'] !== 'string' || message['taskId'] === '';
    if (createsTask && deps.openTasks(caller) >= limits.maxOpenTasksPerCaller) {
      const limit = limits.maxOpenTasksPerCaller;
      reject(response, 429, -32_000, t('server.limit.open-tasks', { limit }));
      return;
    }
    next();
  };
}
