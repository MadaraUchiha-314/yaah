/**
 * The HTTP plugin: one Express listener carrying the agent card and both A2A bindings,
 * each served by the SDK's own handlers. Provides the `http` service.
 */
import type { Server } from 'node:http';

import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from '@a2a-js/sdk/server/express';
import type { Context } from 'cordis';
import type { Express } from 'express';
import express from 'express';

import { JSONRPC_PATH, REST_PATH } from './api-server/agent-card.ts';
import { limitGuard, originGuard } from './api-server/guards.ts';

/** The running listener. */
export interface HttpService {
  /** Where the harness is reachable, without a trailing slash. */
  readonly url: string;
  /** The Express application, for plugins that add routes (the web UI). */
  readonly app: Express;
}

declare module 'cordis' {
  interface Context {
    /** The HTTP listener of this harness. */
    http: HttpService;
  }
  interface Events {
    /** The listener is up. */
    'http/listening'(url: string): void;
  }
}

export const name = 'http';
export const inject: readonly string[] = ['config', 'a2a', 'strings'];

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

function listen(app: Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve: (server: Server) => void, reject: (error: Error) => void) => {
    const server = app.listen(port, host, () => {
      resolve(server);
    });
    server.once('error', reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve: () => void) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

/** Starts the listener. */
export async function apply(ctx: Context): Promise<void> {
  const { server: settings, limits } = ctx.config;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', settings.trustProxy);
  const guards = {
    limits,
    allowedOrigins: settings.allowedOrigins,
    trustProxy: settings.trustProxy,
    openTasks: (caller: string): number => ctx.a2a.openTasks(caller),
  };
  app.use(originGuard(guards));
  const server = await listen(app, settings.host, settings.port);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : settings.port;
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  const url = `http://${host}:${String(port)}`;
  const requestHandler = ctx.a2a.handlerFor(url);
  const userBuilder = UserBuilder.noAuthentication;
  const body = express.json({
    limit: limits.maxBodyBytes,
    type: ['application/json', 'application/a2a+json'],
  });
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(REST_PATH, body, limitGuard(guards), restHandler({ requestHandler, userBuilder }));
  app.use(JSONRPC_PATH, body, limitGuard(guards), jsonRpcHandler({ requestHandler, userBuilder }));
  ctx.effect(() => {
    const release = ctx.provide('http', { url, app });
    return async (): Promise<void> => {
      release();
      await close(server);
    };
  });
  if (!LOOPBACK.has(settings.host)) {
    // No authentication exists: say so, every time, when the API is reachable from elsewhere.
    process.stderr.write(`${ctx.strings.t('server.unauthenticated-bind', { address: url })}\n`);
  }
  ctx.emit('http/listening', url);
}
