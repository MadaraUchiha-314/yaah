/**
 * Keeps one configured MCP server's tools in the entity registry for as long as the
 * server is reachable: connect, list, register; on a drop, unregister and reconnect
 * with exponential backoff.
 */
import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { isJsonObject } from '../../../kernel/json.ts';
import type { Disposer, EntityRegistry } from '../../../kernel/registry.ts';
import { t } from '../../../kernel/strings.ts';
import { isUsableSchema } from '../execute.ts';
import type { Tool } from '../types.ts';
import { errorResult } from '../types.ts';
import type { BackoffConfig } from './backoff.ts';
import { backoffDelay } from './backoff.ts';
import { mcpToolId } from './naming.ts';
import { classifyFailure, errorText, failureResult, mapCallResult, toJson } from './result.ts';
import type { McpSession, RemoteTool } from './session.ts';
import { McpConfigError, localityUrl } from './transport.ts';

/**
 * Why a listed tool was not registered.
 *
 * - `invalid-id`: its id would be empty or longer than a model accepts.
 * - `duplicate`: its id is already taken, by another tool of the server or by anything
 *   else in the registry.
 * - `no-input-schema`: it declares no usable JSON Schema for its arguments.
 */
export type McpSkipReason = 'invalid-id' | 'duplicate' | 'no-input-schema';

/** What a connection reports. Called synchronously; must not throw. */
export interface McpEvents {
  /** The server is connected and these tool ids are registered. */
  connected(serverId: string, toolIds: readonly string[]): void;
  /**
   * The server cannot be used: it did not connect, or it dropped. `retryInMs` is the wait
   * before the next attempt, or null when there will be none (unusable configuration).
   */
  unavailable(serverId: string, reason: string, retryInMs: number | null): void;
  /** A tool the server lists was not registered. */
  skipped(serverId: string, toolName: string, reason: McpSkipReason): void;
}

/** What a {@link ServerConnection} is built from. */
export interface ConnectionOptions {
  readonly server: McpServerConfig;
  readonly backoff: BackoffConfig;
  readonly registry: EntityRegistry;
  readonly events: McpEvents;
  /** Connects to the server. Rejects when it cannot be reached. */
  readonly open: (server: McpServerConfig) => Promise<McpSession>;
}

/**
 * One server's connection and its registered tools.
 *
 * Invariants:
 * - The server's tools are in the registry exactly while a session is live.
 * - At most one session and at most one pending retry exist at a time.
 * - After {@link stop}, nothing is registered, connected or scheduled, and nothing will be.
 * - No method rejects, and no registered tool's `invoke` throws.
 */
export class ServerConnection {
  readonly #options: ConnectionOptions;
  #session: McpSession | null = null;
  #disposers: Disposer[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive failed attempts since the last successful connection. */
  #failures = 0;
  #stopped = false;

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  /**
   * Makes the first connection attempt. Resolves once it has succeeded (the tools are
   * registered) or failed (a retry is scheduled) — never rejects.
   */
  async start(): Promise<void> {
    await this.#attempt();
  }

  /** Removes the tools, cancels any retry and closes the session. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#unregister();
    const session = this.#session;
    this.#session = null;
    await session?.close();
  }

  async #attempt(): Promise<void> {
    const { server, open, events } = this.#options;
    let session: McpSession | null = null;
    try {
      session = await open(server);
      const tools = await session.listTools();
      if (this.#stopped) {
        await session.close();
        return;
      }
      const live = session;
      live.onClose(() => {
        this.#lost(live, t('mcp.error.disconnected', { server: server.id }));
      });
      this.#session = live;
      this.#failures = 0;
      events.connected(server.id, this.#register(tools, live));
    } catch (error) {
      await session?.close();
      this.#retry(errorText(error), error instanceof McpConfigError);
    }
  }

  #retry(reason: string, permanent: boolean): void {
    if (this.#stopped) {
      return;
    }
    const { server, backoff, events } = this.#options;
    if (permanent) {
      events.unavailable(server.id, reason, null);
      return;
    }
    const delay = backoffDelay(this.#failures, backoff);
    this.#failures += 1;
    events.unavailable(server.id, reason, delay);
    this.#timer = setTimeout(() => {
      void this.#attempt();
    }, delay);
  }

  /** Ends `session` if it is still the live one: tools out, connection closed, retry. */
  #lost(session: McpSession, reason: string): void {
    if (this.#session !== session) {
      return;
    }
    this.#session = null;
    this.#unregister();
    void session.close();
    this.#retry(reason, false);
  }

  #unregister(): void {
    for (const dispose of this.#disposers) {
      dispose();
    }
    this.#disposers = [];
  }

  #register(tools: readonly RemoteTool[], session: McpSession): string[] {
    const { server, registry, events } = this.#options;
    const ids: string[] = [];
    for (const remote of tools) {
      const built = this.#build(remote, session);
      if (typeof built === 'string') {
        events.skipped(server.id, remote.name, built);
      } else if (registry.has(built.ref)) {
        events.skipped(server.id, remote.name, 'duplicate');
      } else {
        this.#disposers.push(registry.register(built));
        ids.push(built.ref.id);
      }
    }
    return ids;
  }

  /** The tool entity for `remote`, or the reason it cannot be one. Fails closed. */
  #build(remote: RemoteTool, session: McpSession): Tool | McpSkipReason {
    const { server } = this.#options;
    const id = mcpToolId(server.id, remote.name);
    if (id === null) {
      return 'invalid-id';
    }
    const inputSchema = toJson(remote.inputSchema);
    if (inputSchema === undefined || !isJsonObject(inputSchema) || !isUsableSchema(inputSchema)) {
      return 'no-input-schema';
    }
    const { annotations } = remote;
    return {
      ref: { kind: 'tool', id, version: null },
      // Passed through as the server wrote it: the context builder treats it as untrusted.
      description: remote.description ?? '',
      locality: { type: 'remote', protocol: 'mcp', url: localityUrl(server) },
      inputSchema,
      retrySafe: annotations?.readOnlyHint === true || annotations?.idempotentHint === true,
      invoke: async (args, call) => {
        if (this.#session !== session) {
          return errorResult('unavailable', t('mcp.error.disconnected', { server: server.id }));
        }
        try {
          const result = await session.callTool(
            remote.name,
            isJsonObject(args) ? args : {},
            call.signal,
          );
          return mapCallResult(result);
        } catch (error) {
          if (classifyFailure(error, call.signal.aborted) === 'unavailable') {
            this.#lost(session, errorText(error));
          }
          return failureResult(error, call.signal.aborted);
        }
      },
    };
  }
}
