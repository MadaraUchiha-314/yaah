import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { EntityRegistry } from '../../kernel/registry.ts';
import { Hooks } from '../hooks/service.ts';
import type { McpService } from '../tools/mcp/index.ts';
import type { AgentPluginSource } from './loader.ts';
import { loadPlugin } from './loader.ts';
import { readPluginSchemas } from './manifest.ts';

const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** An MCP service that refuses to add the servers named in `refuse`, and counts. */
function fakeMcp(refuse: readonly string[]) {
  const seen = { added: [] as string[], closed: 0 };
  const service: McpService = {
    hasServer: () => false,
    addServer: (server) => {
      if (refuse.includes(server.id)) {
        return Promise.reject(new Error(`cannot add ${server.id}`));
      }
      seen.added.push(server.id);
      return Promise.resolve(() => {
        seen.closed += 1;
        return Promise.resolve();
      });
    },
  };
  return { service, seen };
}

async function attempt(servers: readonly string[], refuse: readonly string[] = []) {
  const hooks = new Hooks();
  const mcp = fakeMcp(refuse);
  const commands: string[] = [];
  const source: AgentPluginSource = {
    manifest: { $schema: PLUGIN, name: 'twin' },
    mcp: {
      $schema: MCP,
      mcpServers: Object.fromEntries(
        servers.map((id) => [id, { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }]),
      ),
    },
    hooks: {
      hooks: [
        {
          event: 'tool.before',
          match: 'mcp__crm__refund',
          run: { type: 'mcp-tool', server: servers[0] ?? '', tool: 'check' },
        },
      ],
    },
    commands: { hello: 'Say hello.' },
  };
  const deps = {
    registry: new EntityRegistry(),
    schemas: await readPluginSchemas(),
    skills: { load: () => Promise.reject(new Error('no skills here')) },
    hooks,
    mcp: mcp.service,
    commands: {
      register: (name: string) => {
        commands.push(name);
      },
    },
    dataDir: await mkdtemp(join(tmpdir(), 'yaah-loader-')),
    hookTimeoutMs: 1000,
  };
  let error = '';
  try {
    await loadPlugin(deps, source);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const payload = { taskId: 't', key: 'k', callId: 'c', args: {}, tool: 'mcp__crm__refund' };
  const verdict = await hooks.dispatch('tool.before', payload);
  return { error, seen: mcp.seen, commands, verdict };
}

describe('loadPlugin (self-review 2, #12)', () => {
  test.each([
    ['db', 'db__admin'],
    ['my.db', 'my_db'],
  ])('refuses %s and %s, which clash once normalised, before adding either', async (a, b) => {
    const { error, seen, commands, verdict } = await attempt([a, b]);
    expect(error).toContain(`"${a}"`);
    expect(error).toContain(`"${b}"`);
    expect(seen.added).toEqual([]);
    expect(commands).toEqual([]);
    expect(verdict).toEqual({ decision: 'allow' });
  });

  test('a server that cannot be added undoes all the plugin registered', async () => {
    const { error, seen, commands, verdict } = await attempt(['crm', 'policy'], ['policy']);
    expect(error).toContain('cannot add policy');
    expect(seen).toEqual({ added: ['crm'], closed: 1 });
    expect(commands).toEqual([]);
    expect(verdict).toEqual({ decision: 'allow' });
  });
});
