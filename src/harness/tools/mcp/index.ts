/**
 * The MCP plugin: connects to every server in `config.mcp.servers` with the official MCP
 * client and registers each server's tools as `tool` entities named
 * `mcp__<server>__<tool>`.
 *
 * A server that is down does not stop start-up: its tools are absent until it connects,
 * and the connection is retried with exponential backoff. Disposing the plugin closes
 * every connection and removes every tool it registered.
 */
import type { Context } from 'cordis';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { YaahError } from '../../../kernel/errors.ts';
import { t } from '../../../kernel/strings.ts';
import type { BackoffConfig } from './backoff.ts';
import { resolveBackoff } from './backoff.ts';
import type { McpEvents, McpSkipReason } from './connection.ts';
import { ServerConnection } from './connection.ts';
import { serverIdsClash } from './naming.ts';
import type { McpSession } from './session.ts';
import { openSession } from './session.ts';
import type { McpLaunch } from './transport.ts';

export type { McpLaunch } from './transport.ts';

/** The MCP service: adds servers after start-up. Used by the agent-plugin loader. */
export interface McpService {
  /**
   * Connects to `server` the way a configured server is connected — same retries, same
   * tool naming, same events — and resolves once the first attempt has succeeded or
   * failed. Never rejects on account of the server.
   *
   * @returns a function that closes the connection and removes the server's tools.
   * @throws YaahError `mcp.server-id` when the id is in use (see {@link McpService.hasServer}):
   *   a second server under one id could answer for the first.
   */
  addServer(server: McpServerConfig, launch?: McpLaunch): Promise<() => Promise<void>>;
  /**
   * Whether a server is connected or being connected under `id`, or under an id whose
   * tools would bear the same names.
   */
  hasServer(id: string): boolean;
}

declare module 'cordis' {
  interface Context {
    /** MCP servers added at run time. */
    mcp: McpService;
  }
  interface Events {
    /** An MCP server is connected and its tools, named by `toolIds`, are registered. */
    'tools/mcp-connected'(serverId: string, toolIds: readonly string[]): void;
    /**
     * An MCP server did not connect, or dropped; its tools are not registered.
     * `retryInMs` is the wait before the next attempt, or null when its configuration is
     * unusable and it will not be retried. `reason` is redacted.
     */
    'tools/mcp-unavailable'(serverId: string, reason: string, retryInMs: number | null): void;
    /** A tool an MCP server lists was not registered. */
    'tools/mcp-skipped'(serverId: string, toolName: string, reason: McpSkipReason): void;
  }
}

/** The plugin's configuration. Everything is optional; times are milliseconds. */
export interface McpPluginConfig {
  /** Reconnection delays. Default: start at 1 s, double, cap at 60 s. */
  readonly backoff?: Partial<BackoffConfig>;
  /**
   * How long start-up waits for the servers' first connection attempts, so that the
   * tools of a healthy server are there for the first task. A server slower than this
   * keeps connecting in the background. Default 5 s.
   */
  readonly startupWaitMs?: number;
  /**
   * How long one request to a server may take. Default 120 s, the harness's own limit
   * for a tool call, so that the harness's limit is the one that applies.
   */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export const name = 'tools-mcp';
export const inject: readonly string[] = ['entities', 'config', 'redactor'];

function events(ctx: Context): McpEvents {
  return {
    connected: (serverId, toolIds) => {
      ctx.emit('tools/mcp-connected', serverId, toolIds);
    },
    unavailable: (serverId, reason, retryInMs) => {
      ctx.emit('tools/mcp-unavailable', serverId, ctx.redactor.redactString(reason), retryInMs);
    },
    skipped: (serverId, toolName, reason) => {
      ctx.emit('tools/mcp-skipped', serverId, toolName, reason);
    },
  };
}

/**
 * Starts one connection per configured server and waits — at most `startupWaitMs` — for
 * their first attempts. Never throws on account of a server. Provides the `mcp` service.
 */
export async function apply(ctx: Context, config: McpPluginConfig = {}): Promise<void> {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shared = { backoff: resolveBackoff(config.backoff), registry: ctx.entities };
  const connect = (server: McpServerConfig, launch?: McpLaunch): ServerConnection =>
    new ServerConnection({
      ...shared,
      events: events(ctx),
      server,
      open: (entry: McpServerConfig): Promise<McpSession> =>
        openSession(entry, { requestTimeoutMs, launch }),
    });
  const connections = new Map<ServerConnection, string>(
    ctx.config.mcp.servers.map((server: McpServerConfig) => [connect(server), server.id]),
  );
  const hasServer = (id: string): boolean =>
    [...connections.values()].some((known: string) => serverIdsClash(known, id));
  ctx.effect(() => async (): Promise<void> => {
    await Promise.all(
      [...connections.keys()].map((connection: ServerConnection) => connection.stop()),
    );
  });
  ctx.provide('mcp', {
    hasServer,
    addServer: async (server: McpServerConfig, launch?: McpLaunch) => {
      if (hasServer(server.id)) {
        throw new YaahError('mcp.server-id', t('mcp.error.server-id', { server: server.id }));
      }
      const connection = connect(server, launch);
      connections.set(connection, server.id);
      await connection.start();
      return async (): Promise<void> => {
        connections.delete(connection);
        await connection.stop();
      };
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve: () => void) => {
    timer = setTimeout(resolve, config.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS);
  });
  const started = Promise.all(
    [...connections.keys()].map((connection: ServerConnection) => connection.start()),
  );
  await Promise.race([started, waited]);
  clearTimeout(timer);
}
