/**
 * Loading one agent plugin (Agent Plugins 1.0.0): its manifest, the skills under
 * `skills/`, the MCP servers of `mcp.json`, and — yaah's client extension — hooks and
 * prompt commands. A plugin given as a directory and one given in memory take the same
 * path; only where each document comes from differs.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Json } from '../../kernel/json.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import type { CommandsService } from '../commands/index.ts';
import type { Hooks } from '../hooks/service.ts';
import type { SkillRefusal, SkillsService } from '../skills/index.ts';
import type { McpService } from '../tools/mcp/index.ts';
import { serverIdsClash } from '../tools/mcp/naming.ts';
import { PluginFiles } from './files.ts';
import type { FileHook, HooksFile } from './hooks-file.ts';
import { EXTENSION_NAMESPACE, hooksFile } from './hooks-file.ts';
import type { PluginSchemas } from './manifest.ts';
import { AgentPluginError, validateManifest } from './manifest.ts';
import type { PluginServer } from './mcp-config.ts';
import { readMcpConfig } from './mcp-config.ts';
import { mcpToolHook } from './mcp-hook.ts';

/**
 * Where a plugin comes from. With `path` alone it is a directory read from disk. Each
 * document given here is used instead of the file of the same name, so a plugin can be
 * declared in code — entirely (no `path`), or over a directory that holds its skills.
 */
export interface AgentPluginSource {
  /** The plugin's root directory. Without it the plugin has no skills and no stdio servers. */
  readonly path?: string | undefined;
  /** The content of `plugin.json`. */
  readonly manifest?: Json | undefined;
  /** The content of `mcp.json`. */
  readonly mcp?: Json | undefined;
  /** The content of `io.github.madarauchiha-314.yaah/hooks.json`. */
  readonly hooks?: Json | undefined;
  /** Prompt commands: name to Markdown text, as `commands/<name>.md` would hold. */
  readonly commands?: Readonly<Record<string, string>> | undefined;
}

/** What loading a plugin registered. */
export interface AgentPluginReport {
  readonly name: string;
  readonly skills: readonly string[];
  /** Ids of the MCP servers being connected; their tools are `mcp__<id>__<tool>`. */
  readonly servers: readonly string[];
  readonly commands: readonly string[];
  /** How many hooks were registered. */
  readonly hooks: number;
  /** What was reported and skipped: unknown fields, invalid servers, refused skills. */
  readonly notices: readonly string[];
}

/** A loaded plugin: the report, and how to remove what it registered. */
export interface LoadedPlugin {
  readonly report: AgentPluginReport;
  dispose(): Promise<void>;
}

/** What the loader registers into. */
export interface LoaderDeps {
  readonly registry: EntityRegistry;
  readonly schemas: PluginSchemas;
  readonly skills: SkillsService;
  readonly hooks: Hooks;
  /** Absent when the MCP plugin is not part of the composition. */
  readonly mcp: McpService | undefined;
  /** Absent when the commands plugin is not part of the composition. */
  readonly commands: CommandsService | undefined;
  /** The directory under which each plugin gets its `PLUGIN_DATA` directory. */
  readonly dataDir: string;
  /** How long a hook's MCP tool may take, in milliseconds. */
  readonly hookTimeoutMs: number;
}

const COMMAND_NAME = /^[A-Za-z][\w-]*$/u;
const COMMANDS_DIR = `${EXTENSION_NAMESPACE}/commands`;

/** Parses a document that is JSON text; `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** The plugin's own document if given, else the file's content; null when neither exists. */
async function document(
  files: PluginFiles,
  given: Json | undefined,
  file: string,
): Promise<unknown> {
  if (given !== undefined) {
    return given;
  }
  const text = await files.text(file);
  return text === null ? null : parseJson(text);
}

function readHooks(
  raw: unknown,
  plugin: string,
  servers: readonly PluginServer[],
): readonly FileHook[] {
  if (raw === null) {
    return [];
  }
  const parsed = hooksFile.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const rule = `hooks.json ${(issue?.path ?? []).join('.')}`.trim();
    throw new AgentPluginError(plugin, rule, issue?.message ?? '');
  }
  const file: HooksFile = parsed.data;
  const declared = new Set(servers.map((server: PluginServer) => server.config.id));
  const stray = file.hooks.find((hook: FileHook) => !declared.has(hook.run.server));
  if (stray !== undefined) {
    // A policy that cannot be asked must not be skipped silently: the plugin is refused.
    const detail = t('plugin.rule.hook-server', { server: stray.run.server });
    throw new AgentPluginError(plugin, 'hooks.json run.server', detail);
  }
  return file.hooks;
}

async function readCommands(
  files: PluginFiles,
  source: AgentPluginSource,
  notices: string[],
): Promise<Map<string, string>> {
  const commands = new Map<string, string>(Object.entries(source.commands ?? {}));
  const names = (await files.list(COMMANDS_DIR)).filter((file: string) => file.endsWith('.md'));
  const texts = await Promise.all(
    names.map((file: string) => files.text(`${COMMANDS_DIR}/${file}`)),
  );
  for (const [index, file] of names.entries()) {
    const text = texts[index];
    if (typeof text === 'string' && !commands.has(file.slice(0, -3))) {
      commands.set(file.slice(0, -3), text);
    }
  }
  for (const command of [...commands.keys()].filter((key: string) => !COMMAND_NAME.test(key))) {
    notices.push(t('plugin.notice.command-name', { command }));
    commands.delete(command);
  }
  return commands;
}

/** Registers the plugin's prompt commands, adding the removal of each to `undo`. */
function registerCommands(
  deps: LoaderDeps,
  plugin: string,
  commands: ReadonlyMap<string, string>,
  out: { readonly notices: string[]; readonly undo: (() => void)[] },
): string[] {
  const registered: string[] = [];
  for (const [command, text] of commands) {
    try {
      if (deps.commands === undefined) {
        throw new Error(t('plugin.rule.no-commands'));
      }
      const remove = deps.commands.register(
        command,
        (args: string) =>
          Promise.resolve({
            text: '',
            prompt: args === '' ? text.trim() : `${text.trim()}\n\n${args}`,
          }),
        t('plugin.command.description', { plugin }),
      );
      out.undo.push(remove);
      registered.push(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      out.notices.push(t('plugin.notice.command-skipped', { command, reason }));
    }
  }
  return registered;
}

/** Registers the skills under `skills/`, when that is a directory inside the plugin (§6.2). */
async function loadSkills(
  deps: LoaderDeps,
  files: PluginFiles,
  notices: string[],
  undo: (() => void)[],
): Promise<readonly string[]> {
  const { root } = files;
  let kind: Awaited<ReturnType<PluginFiles['kind']>> = 'other';
  try {
    kind = await files.kind('skills');
  } catch {
    // Outside the plugin: the component type is invalid, the plugin loads without it.
  }
  if (root === null || kind === null) {
    return [];
  }
  if (kind !== 'directory') {
    notices.push(t('plugin.notice.skills-invalid'));
    return [];
  }
  const loaded = await deps.skills.load(join(root, 'skills'), root);
  undo.push((): void => {
    loaded.dispose();
  });
  notices.push(...loaded.refused.map((refusal: SkillRefusal) => refusal.message));
  return loaded.registered;
}

/** Refuses a plugin two of whose servers would give their tools the same names. */
function checkOwnServers(plugin: string, servers: readonly PluginServer[]): void {
  const ids = servers.map((server: PluginServer) => server.config.id);
  for (const [index, id] of ids.entries()) {
    const other = ids.slice(index + 1).find((later: string) => serverIdsClash(id, later));
    if (other !== undefined) {
      const detail = t('plugin.rule.server-clash', { server: id, other });
      throw new AgentPluginError(plugin, `mcp.json ${id}: server id clash`, detail);
    }
  }
}

/**
 * Adds the plugin's servers. When one cannot be added, those that were are closed and
 * the error is passed on, so that the caller can undo the rest.
 */
async function addServers(
  service: McpService,
  servers: readonly PluginServer[],
): Promise<(() => Promise<void>)[]> {
  const added = await Promise.allSettled(
    servers.map((server: PluginServer) => service.addServer(server.config, server.launch)),
  );
  const closers = added.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failed = added.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    await Promise.all(closers.map((close: () => Promise<void>) => close()));
    throw failed.reason;
  }
  return closers;
}

/** What a plugin declares, read and checked, with nothing registered yet. */
interface Declared {
  readonly files: PluginFiles;
  readonly name: string;
  readonly servers: readonly PluginServer[];
  readonly hooks: readonly FileHook[];
  readonly commands: ReadonlyMap<string, string>;
  readonly notices: string[];
}

async function declare(deps: LoaderDeps, source: AgentPluginSource): Promise<Declared> {
  const label = source.path ?? t('plugin.in-memory');
  const files =
    source.path === undefined ? new PluginFiles(null, label) : await PluginFiles.open(source.path);
  const rawManifest = await document(files, source.manifest, 'plugin.json');
  if (rawManifest === null || rawManifest === undefined) {
    throw new AgentPluginError(label, '§5.1 plugin.json', t('plugin.rule.manifest-missing'));
  }
  const { manifest, notices: reported } = validateManifest(rawManifest, deps.schemas.plugin, label);
  const notices = [...reported];
  const data = join(deps.dataDir, manifest.name);
  await mkdir(data, { recursive: true });
  const rawMcp = await document(files, source.mcp, 'mcp.json');
  const mcp =
    rawMcp === null
      ? { servers: [], notices: [] }
      : await readMcpConfig(rawMcp, deps.schemas.mcp, { root: files.root, data });
  notices.push(...mcp.notices);
  const rawHooks = await document(files, source.hooks, `${EXTENSION_NAMESPACE}/hooks.json`);
  const taken = mcp.servers.find(
    (server: PluginServer) => deps.mcp?.hasServer(server.config.id) === true,
  );
  if (taken !== undefined) {
    // A second server under one id could answer the first one's policy hooks.
    const { id } = taken.config;
    const detail = t('mcp.error.server-id', { server: id });
    throw new AgentPluginError(manifest.name, `mcp.json ${id}: server id in use`, detail);
  }
  checkOwnServers(manifest.name, mcp.servers);
  const hooks = readHooks(rawHooks, manifest.name, mcp.servers);
  const commands = await readCommands(files, source, notices);
  return { files, name: manifest.name, servers: mcp.servers, hooks, commands, notices };
}

/** Removes what a loaded plugin registered and closes its servers. */
function disposer(undo: (() => void)[], closers: (() => Promise<void>)[]): () => Promise<void> {
  return async (): Promise<void> => {
    for (const remove of undo.splice(0)) {
      remove();
    }
    await Promise.all(closers.splice(0).map((close: () => Promise<void>) => close()));
  };
}

/**
 * Loads one plugin and registers what it declares.
 *
 * Order matters for safety: hooks are registered before the plugin's servers connect, so
 * no tool of the plugin is ever callable without the plugin's own policy in front of it.
 *
 * @throws AgentPluginError naming the rule, and registering nothing, when: the directory
 *   or its `plugin.json` is missing, is not JSON, or lies outside the root (§4.1); the
 *   manifest breaks §5 (see `validateManifest`); `hooks.json` breaks its schema, or names
 *   a server the plugin's `mcp.json` does not validly declare; `mcp.json` declares a server
 *   under an id that is already in use, or two servers whose tools would bear the same
 *   names. When a server cannot be added, what was registered is removed and the error
 *   passed on.
 */
export async function loadPlugin(
  deps: LoaderDeps,
  source: AgentPluginSource,
): Promise<LoadedPlugin> {
  const { files, name, servers, hooks, commands, notices } = await declare(deps, source);
  const options = { registry: deps.registry, timeoutMs: deps.hookTimeoutMs };
  const undo: (() => void)[] = hooks.map((hook: FileHook) =>
    deps.hooks.register(hook.event, {
      match: hook.match,
      run: mcpToolHook(options, hook.event, hook.run),
    }),
  );
  const { mcp: service } = deps;
  if (service === undefined && servers.length > 0) {
    notices.push(t('plugin.notice.no-mcp'));
  }
  try {
    const skills = await loadSkills(deps, files, notices, undo);
    const closers = service === undefined ? [] : await addServers(service, servers);
    // Last, so a plugin refused by a step above has registered no command.
    const registered = registerCommands(deps, name, commands, { notices, undo });
    const report = {
      name,
      skills,
      servers: closers.map((_close: unknown, index: number) => servers[index]?.config.id ?? ''),
      commands: registered,
      hooks: hooks.length,
      notices,
    };
    return { report, dispose: disposer(undo, closers) };
  } catch (error) {
    for (const remove of undo.splice(0)) {
      remove();
    }
    throw error;
  }
}
