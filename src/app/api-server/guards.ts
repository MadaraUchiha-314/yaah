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

/** What the guards need to know about the harness. */
export interface GuardDeps {
  readonly limits: GuardLimits;
  /** Origins allowed besides the server's own. */
  readonly allowedOrigins: readonly string[];
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

/** The key the per-caller limits count against: the remote address, since nobody is identified. */
export function callerKey(request: Request, trustProxy: boolean): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string' && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() ?? '';
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * Rejects a browser request from an origin that is neither the server's own nor allowed.
 * A request without an `Origin` header — any non-browser client — passes: this guard
 * exists to stop a web page the user happens to visit from driving a local harness.
 */
export function originGuard(deps: GuardDeps): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const { origin } = request.headers;
    if (origin === undefined) {
      next();
      return;
    }
    const own = `${request.protocol}://${request.headers.host ?? ''}`;
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
  const recent = new Map<string, number[]>();
  return (request: Request, response: Response, next: NextFunction): void => {
    const caller = callerKey(request, deps.trustProxy);
    // Overwrites whatever the client sent: only this layer names the caller.
    request.headers[CALLER_HEADER] = caller;
    const since = now() - MINUTE_MS;
    const stamps = (recent.get(caller) ?? []).filter((stamp: number) => stamp > since);
    stamps.push(now());
    recent.set(caller, stamps);
    if (stamps.length > limits.maxRequestsPerMinute) {
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
