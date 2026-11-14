/**
 * `mcp.json` of an agent plugin (Agent Plugins 1.0.0, §7.2 and §9): which MCP servers the
 * plugin declares, turned into what the MCP plugin connects to.
 *
 * Failure boundaries follow §7.2.2: a file that is unusable as a whole disables MCP for
 * the plugin; an entry that breaks a rule is skipped alone. Both are reported, neither
 * stops the plugin's other components.
 */
import { isIP } from 'node:net';

import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';

import type { McpServerConfig } from '../../kernel/config-types.ts';
import type { JsonObject } from '../../kernel/json.ts';
import { resolveInside } from '../../kernel/paths.ts';
import { t } from '../../kernel/strings.ts';
import type { McpLaunch } from '../tools/mcp/transport.ts';
import { MCP_SCHEMA_ID, ruleOf } from './manifest.ts';

/** One server of a plugin, ready to connect. */
export interface PluginServer {
  readonly config: McpServerConfig;
  readonly launch: McpLaunch;
}

/** The usable servers of an `mcp.json` and what was reported on the way. */
export interface McpConfigOutcome {
  readonly servers: readonly PluginServer[];
  readonly notices: readonly string[];
}

/** The two directories a server's configuration may refer to. */
export interface PluginDirs {
  /** The real path of the plugin's root; null for a plugin that exists only in memory. */
  readonly root: string | null;
  /** The plugin's data directory, `PLUGIN_DATA`. */
  readonly data: string;
}

const strings = z.record(z.string(), z.string());
const stdio = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: strings.default({}),
  cwd: z.string().optional(),
});
const remote = z.object({
  type: z.enum(['streamable-http', 'sse']),
  url: z.string(),
  headers: strings.default({}),
});
const entry = z.union([stdio, remote]);
const topLevel = z.object({ mcpServers: z.record(z.string(), z.unknown()) });
const typed = z.object({ type: z.string() });

/** An entry broke a rule: `rule` names it, with its section. */
class EntryError extends Error {
  constructor(rule: string) {
    super(rule);
    this.name = 'EntryError';
  }
}

const PLACEHOLDER = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu;
const PLACEHOLDER_LIKE = /\$\{[^}]*\}/gu;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// oxlint-disable-next-line no-control-regex -- a header value may hold a tab and no other control character
const HEADER_VALUE = /^[\t -~\u0080-ÿ]*$/u;

/**
 * Replaces every `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `value`, once, without reading
 * the result again (§9.2). Any other `${…}` stays as written and is named in `unknown`.
 */
export function expandPlaceholders(
  value: string,
  dirs: { readonly root: string; readonly data: string },
  unknown: string[] = [],
): string {
  for (const [found] of value.matchAll(PLACEHOLDER_LIKE)) {
    if (found !== '${PLUGIN_ROOT}' && found !== '${PLUGIN_DATA}') {
      unknown.push(found);
    }
  }
  return value.replaceAll(PLACEHOLDER, (_whole: string, which: string) =>
    which === 'PLUGIN_ROOT' ? dirs.root : dirs.data,
  );
}

async function inside(root: string, path: string, rule: string): Promise<string> {
  try {
    return await resolveInside(root, path);
  } catch {
    throw new EntryError(rule);
  }
}

/** The working directory of a stdio server: one of the three forms of §7.2.1, contained. */
function workingDirectory(
  cwd: string | undefined,
  dirs: { readonly root: string; readonly data: string },
): Promise<string> {
  if (cwd === undefined) {
    return Promise.resolve(dirs.root);
  }
  const base = cwd.startsWith('${PLUGIN_DATA}') ? dirs.data : dirs.root;
  return inside(base, expandPlaceholders(cwd, dirs), '§7.2.1 cwd: containment');
}

async function stdioServer(
  id: string,
  server: z.infer<typeof stdio>,
  dirs: PluginDirs,
  unknown: string[],
): Promise<PluginServer> {
  const { root, data } = dirs;
  if (root === null) {
    throw new EntryError('§9.1 stdio: needs a plugin root');
  }
  const bundled = server.command.startsWith('./');
  if (!bundled && /[\s/\\]/u.test(server.command)) {
    throw new EntryError('§7.2.1 command: single token');
  }
  const command = bundled
    ? await inside(root, server.command, '§4.1 command: containment')
    : server.command;
  const expand = (value: string): string => expandPlaceholders(value, { root, data }, unknown);
  const env = Object.fromEntries(
    Object.entries(server.env).map(([key, value]) => [key, expand(value)]),
  );
  return {
    config: {
      id,
      transport: 'stdio',
      command,
      args: server.args.map((argument: string) => expand(argument)),
      env: [],
      url: undefined,
    },
    launch: {
      // §9.1: the configured values first, then the two reserved names, which win.
      env: { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
      cwd: await workingDirectory(server.cwd, { root, data }),
    },
  };
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replaceAll(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function remoteServer(id: string, server: z.infer<typeof remote>): PluginServer {
  if (server.type === 'sse') {
    throw new EntryError('§7.2.2 type: the sse transport is not supported');
  }
  const url = URL.canParse(server.url) ? new URL(server.url) : null;
  const secure =
    url?.protocol === 'https:' || (url?.protocol === 'http:' && isLoopback(url.hostname));
  const plain = url?.username === '' && url.password === '' && !server.url.includes('#');
  if (url === null || !secure || !plain) {
    throw new EntryError('§7.2.1 url');
  }
  const names = Object.keys(server.headers).map((header: string) => header.toLowerCase());
  const valid = Object.entries(server.headers).every(
    ([header, value]) => HEADER_NAME.test(header) && HEADER_VALUE.test(value),
  );
  if (!valid || new Set(names).size !== names.length) {
    throw new EntryError('§7.2.1 headers');
  }
  return {
    config: { id, transport: 'http', command: undefined, args: [], env: [], url: server.url },
    launch: { headers: server.headers },
  };
}

/** The reason the file as a whole cannot be used (§7.2.2 rule 2), or null. */
function fileProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '§7.2.1 mcp.json: type';
  }
  const fields: Readonly<Record<string, unknown>> = { ...raw };
  if (fields['$schema'] !== MCP_SCHEMA_ID) {
    return fields['$schema'] === undefined
      ? '§7.2.1 $schema: required'
      : '§10.1 $schema: version differs from plugin.json or is not supported';
  }
  if (!topLevel.safeParse(raw).success) {
    return '§7.2.1 mcpServers: type';
  }
  const extra = Object.keys(fields).find(
    (key: string) => key !== '$schema' && key !== 'mcpServers',
  );
  return extra === undefined ? null : `§7.2.1 ${extra}: additionalProperties`;
}

const VARIANTS: Readonly<Record<string, string>> = {
  stdio: 'stdioServer',
  'streamable-http': 'streamableHttpServer',
  sse: 'sseServer',
};

/** Checks one entry against the closed schema of the transport it names. */
function checkEntry(value: unknown, schema: JsonObject): z.infer<typeof entry> {
  const type = typed.safeParse(value);
  const variant = type.success ? VARIANTS[type.data.type] : undefined;
  if (variant === undefined) {
    throw new EntryError('§7.2.1 type: unknown');
  }
  const closed = { $ref: `#/$defs/${variant}`, $defs: schema['$defs'] ?? {} };
  const checked = new Validator(closed, '2020-12', false).validate(value);
  if (!checked.valid) {
    throw new EntryError(ruleOf(checked.errors).rule.replace(/^§\S+/u, '§7.2.1'));
  }
  return entry.parse(value);
}

/**
 * Reads a parsed `mcp.json`.
 *
 * Checked for the file: an object with `$schema` — the 1.0.0 identifier, hence the
 * version of `plugin.json` — and `mcpServers`, and nothing else. Checked for each entry:
 * the closed schema of its transport; for stdio, `command` is one token, a bare name or a
 * `./` path inside the plugin, `env` does not set `PLUGIN_ROOT` or `PLUGIN_DATA`, `cwd` has
 * one of the three allowed forms and stays inside the directory it names; for
 * `streamable-http`, the URL is absolute, `https` unless loopback, without user
 * information or fragment, and headers are valid and unique whatever their case. An `sse`
 * entry is skipped: yaah does not speak that transport.
 *
 * Only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, in `args`, `env` values and
 * `cwd`. Any other `${…}` is left as written, as §9.2 requires, and named in a notice.
 */
export async function readMcpConfig(
  raw: unknown,
  schema: JsonObject,
  dirs: PluginDirs,
): Promise<McpConfigOutcome> {
  const problem = fileProblem(raw);
  if (problem !== null) {
    return { servers: [], notices: [t('plugin.notice.mcp-disabled', { rule: problem })] };
  }
  const servers: PluginServer[] = [];
  const notices: string[] = [];
  for (const [id, value] of Object.entries(topLevel.parse(raw).mcpServers)) {
    const unknown: string[] = [];
    try {
      const server = checkEntry(value, schema);
      servers.push(
        server.type === 'stdio'
          ? // oxlint-disable-next-line no-await-in-loop -- entries are few; order is kept
            await stdioServer(id, server, dirs, unknown)
          : remoteServer(id, server),
      );
    } catch (error) {
      const rule = error instanceof Error ? error.message : String(error);
      notices.push(t('plugin.notice.server-skipped', { server: id, rule }));
    }
    for (const placeholder of new Set(unknown)) {
      notices.push(t('plugin.notice.placeholder', { server: id, placeholder }));
    }
  }
  return { servers, notices };
}
