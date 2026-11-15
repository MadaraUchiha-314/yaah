/**
 * Choosing and building the SDK transport for a configured MCP server.
 *
 * Security: a stdio server is a child process the model can reach through its tools. It
 * is started with the environment variables its configuration names and nothing else of
 * the harness's environment, so it cannot read the harness's API keys.
 */
import type { Transport } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { YaahError } from '../../../kernel/errors.ts';
import { t } from '../../../kernel/strings.ts';

/** A server entry that can never connect as written. Retrying it is pointless. */
export class McpConfigError extends YaahError {
  constructor(message: string) {
    super('mcp.config', message);
  }
}

/** Always passed to a stdio server, so that its command can find its interpreter. */
const ALWAYS_PASSED = 'PATH';

/**
 * The environment a stdio server is started with: the variables in `names` that are set
 * in `source`, plus `PATH`.
 *
 * Invariant: no variable outside `names` and `PATH` is ever returned, whatever `source`
 * holds. (The SDK's stdio transport then adds its own fixed list of harmless variables —
 * `HOME`, `LOGNAME`, `SHELL`, `TERM`, `USER` on POSIX — which this function cannot remove.)
 */
export function stdioEnvironment(
  names: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [ALWAYS_PASSED, ...names]) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * How a server added at run time is started or reached, beyond what a configured entry
 * can say. Used for the servers an agent plugin declares.
 */
export interface McpLaunch {
  /** stdio: variables set for the process, by value, besides those passed through. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** stdio: the working directory of the process. */
  readonly cwd?: string | undefined;
  /**
   * http: fixed headers sent with every request. They never reach another origin: the
   * SDK's transport follows a redirect only within the origin of the request, and that
   * default (`redirectPolicy: 'same-origin'`) is stated here so it cannot change unseen.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

function httpUrl(server: McpServerConfig): URL {
  const url = server.url === undefined || !URL.canParse(server.url) ? null : new URL(server.url);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new McpConfigError(t('mcp.config.no-url', { server: server.id }));
  }
  return url;
}

/**
 * Builds the transport `server` asks for, unstarted.
 *
 * The stdio transport is imported only when a stdio server is configured, so a build
 * without child processes (the browser) never loads it.
 *
 * @throws McpConfigError when a stdio server has no command, or an http server has no
 *   `http:` / `https:` URL.
 */
export async function createTransport(
  server: McpServerConfig,
  launch: McpLaunch = {},
): Promise<Transport> {
  if (server.transport === 'http') {
    return new StreamableHTTPClientTransport(httpUrl(server), {
      redirectPolicy: 'same-origin',
      ...(launch.headers === undefined ? {} : { requestInit: { headers: { ...launch.headers } } }),
    });
  }
  if (server.command === undefined || server.command === '') {
    throw new McpConfigError(t('mcp.config.no-command', { server: server.id }));
  }
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  return new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: { ...stdioEnvironment(server.env), ...launch.env },
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
  });
}

/** The `locality.url` of a server's tools: its endpoint, or `stdio:<command>`. */
export function localityUrl(server: McpServerConfig): string {
  return server.transport === 'http' ? (server.url ?? '') : `stdio:${server.command ?? ''}`;
}
