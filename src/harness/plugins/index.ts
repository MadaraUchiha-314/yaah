/**
 * The agent-plugins plugin: loads every package of `config.plugins` that conforms to the
 * Agent Plugins specification 1.0.0, and provides the `agentPlugins` service for loading
 * one from code. A plugin that breaks a rule is refused by name and reported; the others
 * load and the harness starts.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Context } from 'cordis';

import type { AgentPluginReport, AgentPluginSource } from './loader.ts';
import { loadPlugin } from './loader.ts';
import { AgentPluginError, readPluginSchemas } from './manifest.ts';

export {
  EXTENSION_NAMESPACE,
  HOOKS_SCHEMA_PATH,
  hooksFile,
  hooksJsonSchemas,
} from './hooks-file.ts';
export type { FileHook, HooksFile } from './hooks-file.ts';
export { loadPlugin } from './loader.ts';
export type { AgentPluginReport, AgentPluginSource, LoadedPlugin, LoaderDeps } from './loader.ts';
export {
  AGENT_PLUGINS_VERSION,
  AgentPluginError,
  MCP_SCHEMA_ID,
  PLUGIN_SCHEMA_ID,
  readPluginSchemas,
  validateManifest,
} from './manifest.ts';
export type { ManifestOutcome, PluginManifest, PluginSchemas } from './manifest.ts';
export { expandPlaceholders, readMcpConfig } from './mcp-config.ts';
export type { McpConfigOutcome, PluginDirs, PluginServer } from './mcp-config.ts';
export { mcpToolHook } from './mcp-hook.ts';

/** The agent-plugins service. */
export interface AgentPluginsService {
  /**
   * Loads one plugin — a directory, or documents given in memory — and registers its
   * skills, MCP servers, hooks and prompt commands for as long as the harness runs.
   *
   * @throws AgentPluginError naming the violated rule; nothing of the plugin is registered.
   */
  load(source: AgentPluginSource): Promise<AgentPluginReport>;
}

/** The plugin's configuration. */
export interface AgentPluginsConfig {
  /** How long a hook's MCP tool may take before the hook denies. Default 10 s. */
  readonly hookTimeoutMs?: number;
}

declare module 'cordis' {
  interface Context {
    /** Agent Plugins packages. */
    agentPlugins: AgentPluginsService;
  }
  interface Events {
    /** An agent plugin was loaded. */
    'plugins/loaded'(report: AgentPluginReport): void;
    /** An agent plugin was refused; `message` names it and the rule it broke. */
    'plugins/refused'(path: string, rule: string, message: string): void;
  }
}

export const name = 'agent-plugins';
export const inject: readonly string[] = ['entities', 'config', 'skills', 'hooks'];

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** Where plugins keep their data: beside the stores, or in the temporary directory. */
function dataRoot(dataDir: string): string {
  if (dataDir === ':memory:') {
    return join(tmpdir(), 'yaah-plugin-data');
  }
  return join(dataDir === '' ? join(homedir(), '.yaah', 'data') : dataDir, 'plugins');
}

/**
 * Loads an agent plugin from code — call it from `createHarness({ setup })`:
 *
 * ```ts
 * await createHarness({ setup: (ctx) => loadAgentPlugin(ctx, { path: './my-plugin' }) });
 * ```
 *
 * @throws AgentPluginError naming the violated rule.
 */
export function loadAgentPlugin(
  ctx: Context,
  source: AgentPluginSource,
): Promise<AgentPluginReport> {
  return ctx.agentPlugins.load(source);
}

/** Starts the agent-plugins plugin. */
export async function apply(ctx: Context, config: AgentPluginsConfig = {}): Promise<void> {
  const schemas = await readPluginSchemas();
  const load = async (source: AgentPluginSource): Promise<AgentPluginReport> => {
    const loaded = await loadPlugin(
      {
        registry: ctx.entities,
        schemas,
        skills: ctx.skills,
        hooks: ctx.hooks,
        mcp: ctx.get('mcp'),
        commands: ctx.get('commands'),
        dataDir: dataRoot(ctx.config.dataDir),
        hookTimeoutMs: config.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      },
      source,
    );
    ctx.effect(() => (): Promise<void> => loaded.dispose());
    ctx.emit('plugins/loaded', loaded.report);
    const { notices } = loaded.report;
    if (notices.length > 0) {
      const facts = { event: 'plugins/loaded', plugin: loaded.report.name, notices };
      ctx.get('log')?.record('harness.event', facts, 'warn');
    }
    return loaded.report;
  };
  ctx.provide('agentPlugins', { load });
  for (const { path } of ctx.config.plugins) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- in order, so the first plugin wins a name
      await load({ path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rule = error instanceof AgentPluginError ? error.rule : 'load';
      ctx.emit('plugins/refused', path, rule, message);
      ctx
        .get('log')
        ?.record('harness.event', { event: 'plugins/refused', path, rule, message }, 'error');
    }
  }
}
