/** Builds agent-plugin directories for tests. */
import { join } from 'node:path';

import { writeTree } from './skills.ts';

/** The `$schema` of a 1.0.0 `plugin.json`. */
export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** The `$schema` of a 1.0.0 `mcp.json`. */
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
/** yaah's extension directory inside a plugin. */
export const YAAH_DIR = 'io.github.madarauchiha-314.yaah';

/** What {@link writePlugin} writes. Everything but the name is optional. */
export interface PluginSpec {
  readonly name: string;
  /** Replaces the generated `plugin.json` content. */
  readonly manifest?: unknown;
  /** `mcpServers` of `mcp.json`. */
  readonly servers?: Readonly<Record<string, unknown>>;
  /** `hooks` of the extension's `hooks.json`. */
  readonly hooks?: readonly unknown[];
  /** Other files, by path relative to the plugin's root. */
  readonly files?: Readonly<Record<string, string>>;
}

/** Writes a plugin under `<parent>/<name>` and returns its root. */
export async function writePlugin(parent: string, spec: PluginSpec): Promise<string> {
  const root = join(parent, spec.name);
  const files: Record<string, string> = {
    'plugin.json': JSON.stringify(spec.manifest ?? { $schema: PLUGIN_SCHEMA, name: spec.name }),
    ...spec.files,
  };
  if (spec.servers !== undefined) {
    files['mcp.json'] = JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: spec.servers });
  }
  if (spec.hooks !== undefined) {
    files[`${YAAH_DIR}/hooks.json`] = JSON.stringify({ hooks: spec.hooks });
  }
  await writeTree(root, files);
  return root;
}

/** `[[plugins]]` configuration naming `paths`. */
export function pluginsConfig(...paths: readonly string[]): string {
  return paths.map((path) => `[[plugins]]\npath = ${JSON.stringify(path)}`).join('\n');
}
