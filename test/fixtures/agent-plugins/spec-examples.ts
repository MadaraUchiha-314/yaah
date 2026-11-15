/**
 * The worked examples of the Agent Plugins specification 1.0.0, copied from its text
 * (https://github.com/agentplugins/agent-plugins-spec, `spec/1.0.0.md`, commit
 * 6395e8906b30e2f333b792bfaa981d790993d56f, read 2026-11-14). The specification publishes
 * no conformance fixtures; these examples are the nearest thing, and the tests hold yaah
 * to what the text says about each.
 */
import type { JsonObject } from '../../../src/kernel/json.ts';

const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** §5.2 "Example: minimal manifest". Valid. */
export const MINIMAL_MANIFEST: JsonObject = { $schema: PLUGIN, name: 'minimal-plugin' };

/** §5.2 "Example: full manifest". Valid. */
export const FULL_MANIFEST: JsonObject = {
  $schema: PLUGIN,
  name: 'plugin-name',
  version: '1.2.0',
  description: 'Brief plugin description',
  author: { name: 'Author Name', email: 'author@example.com', url: 'https://example.com' },
  homepage: 'https://docs.example.com/plugin',
  repository: 'https://github.com/example/plugin',
  license: 'MIT',
  keywords: ['keyword1', 'keyword2'],
  extensions: { 'com.example.client': { setting: true } },
};

/** §5.5: names the text lists as valid. */
export const VALID_NAMES: readonly string[] = ['my-plugin', 'acme.tools', 'lint3r', 'a'];

/** §5.5: names the text lists as invalid. */
export const INVALID_NAMES: readonly string[] = [
  'My-Plugin',
  '-start',
  'has--double',
  'too.many..dots',
  '',
];

/** §4.1, first example: both paths start with `./` and stay inside the plugin. Valid. */
export const MCP_VALID_PATHS: JsonObject = {
  $schema: MCP,
  mcpServers: { server: { type: 'stdio', command: './bin/server', cwd: './data' } },
};

/** §4.1, second example: `../bin/server` escapes and `data` is not plugin-relative. Invalid. */
export const MCP_INVALID_PATHS: JsonObject = {
  $schema: MCP,
  mcpServers: { server: { type: 'stdio', command: '../bin/server', cwd: 'data' } },
};

/** §7.2.1 "Example: mcp.json": one server of each transport. */
export const MCP_ALL_TRANSPORTS: JsonObject = {
  $schema: MCP,
  mcpServers: {
    'local-validator': {
      type: 'stdio',
      command: './bin/validator',
      args: ['--data', '${PLUGIN_DATA}/validator'],
      env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
      cwd: '${PLUGIN_ROOT}',
    },
    'deployment-api': {
      type: 'streamable-http',
      url: 'https://deploy.example.com/mcp',
      headers: { 'X-Tenant': 'public-tenant' },
    },
    'legacy-events': { type: 'sse', url: 'https://legacy.example.com/sse' },
  },
};

/** §9.2 "Example: plugin variable expansion in MCP". */
export const MCP_EXPANSION: JsonObject = {
  $schema: MCP,
  mcpServers: {
    database: {
      type: 'stdio',
      command: 'npx',
      args: ['--config', '${PLUGIN_ROOT}/config/db.json'],
      cwd: '${PLUGIN_ROOT}',
      env: { DATA_DIR: '${PLUGIN_DATA}/database' },
    },
  },
};
