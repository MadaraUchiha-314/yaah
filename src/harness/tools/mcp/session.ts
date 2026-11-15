/**
 * One live connection to an MCP server, reduced to what the plugin needs. The only
 * module that drives the SDK's `Client`; everything else works against {@link McpSession},
 * so the reconnect logic can be tested without a server.
 */
import { Client } from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import type { JsonObject } from '../../../kernel/json.ts';
import { currentTraceparent } from '../../../kernel/trace-context.ts';
import type { McpCallResult } from './result.ts';
import type { McpLaunch } from './transport.ts';
import { createTransport } from './transport.ts';

/** A tool as a server lists it. Everything but the name is optional: servers vary. */
export interface RemoteTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** The JSON Schema of the arguments; checked before use, hence `unknown`. */
  readonly inputSchema?: unknown;
  readonly annotations?:
    | {
        readonly readOnlyHint?: boolean | undefined;
        readonly idempotentHint?: boolean | undefined;
      }
    | undefined;
}

/** A connected MCP server. */
export interface McpSession {
  /** Every tool the server offers, all pages. Rejects when the server cannot be asked. */
  listTools(): Promise<readonly RemoteTool[]>;
  /**
   * Calls a tool. Resolves with the server's result, including one marked `isError`.
   * Rejects when the call was aborted, timed out, was refused by the server, or the
   * server could not be reached.
   */
  callTool(name: string, args: JsonObject, signal: AbortSignal): Promise<McpCallResult>;
  /** Sets the listener told when the connection ends other than through {@link close}. */
  onClose(listener: () => void): void;
  /** Ends the connection; for stdio, stops the server process. Never rejects. */
  close(): Promise<void>;
}

/** What {@link openSession} needs besides the server entry. */
export interface SessionOptions {
  /** How long one request may take before it fails as timed out, in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Process and header settings of a server added at run time. */
  readonly launch?: McpLaunch | undefined;
}

/** How this harness names itself to servers. */
const CLIENT_INFO = { name: 'yaah', version: '0.0.0' } as const;

/**
 * Connects to `server` with the official MCP client and completes the handshake.
 *
 * Result schemas are checked with the validator that does not generate code, as the
 * rest of yaah does, so this also runs under a strict content-security policy.
 *
 * @throws McpConfigError when the entry cannot work as written.
 * @throws Error (from the SDK) when the server cannot be started or reached; nothing is
 *   left running in that case.
 */
export async function openSession(
  server: McpServerConfig,
  options: SessionOptions,
): Promise<McpSession> {
  const transport = await createTransport(server, options.launch);
  const client = new Client(CLIENT_INFO, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  let closing = false;
  const close = async (): Promise<void> => {
    closing = true;
    try {
      await client.close();
    } catch {
      // Closing a connection that is already gone is not a failure worth reporting.
    }
  };
  try {
    await client.connect(transport, { timeout: options.requestTimeoutMs });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    listTools: async () => {
      const listing = await client.listTools(undefined, { timeout: options.requestTimeoutMs });
      return listing.tools;
    },
    callTool: (name, args, signal) => {
      // The call continues the trace of the step making it, when there is one.
      const traceparent = currentTraceparent();
      return client.callTool(
        {
          name,
          arguments: { ...args },
          ...(traceparent === undefined ? {} : { _meta: { traceparent } }),
        },
        { signal, timeout: options.requestTimeoutMs },
      );
    },
    onClose: (listener) => {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's API is this property
      client.onclose = (): void => {
        if (!closing) {
          listener();
        }
      };
    },
    close,
  };
}
