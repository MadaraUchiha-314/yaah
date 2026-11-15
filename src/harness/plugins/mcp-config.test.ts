import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MCP_ALL_TRANSPORTS,
  MCP_EXPANSION,
  MCP_INVALID_PATHS,
  MCP_VALID_PATHS,
} from '../../../test/fixtures/agent-plugins/spec-examples.ts';
import { scratchDir, writeTree } from '../../../test/support/skills.ts';
import { MCP_SCHEMA_ID, readPluginSchemas } from './manifest.ts';
import type { McpConfigOutcome } from './mcp-config.ts';
import { expandPlaceholders, readMcpConfig } from './mcp-config.ts';

const schemas = await readPluginSchemas();
let scratch = '';
let root = '';
let data = '';

beforeAll(async () => {
  scratch = await realpath(await scratchDir('yaah-mcp-config-'));
  root = join(scratch, 'plugin');
  data = join(scratch, 'data');
  await writeTree(root, { 'bin/server': '', 'bin/validator': '', 'data/keep': '' });
  await mkdir(join(data, 'cache'), { recursive: true });
  await writeTree(scratch, { 'outside/tool': '' });
  await symlink(join(scratch, 'outside'), join(root, 'linked'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const read = (raw: unknown, from: string | null = root): Promise<McpConfigOutcome> =>
  readMcpConfig(raw, schemas.mcp, { root: from, data });

/** Reads a file with one server `s` and returns the notice about it, or '' when it loaded. */
async function skipped(server: Readonly<Record<string, unknown>>): Promise<string> {
  const outcome = await read({ $schema: MCP_SCHEMA_ID, mcpServers: { s: server } });
  expect(outcome.servers).toHaveLength(outcome.notices.length === 0 ? 1 : 0);
  return outcome.notices.join('\n');
}

describe('expandPlaceholders', () => {
  const dirs = { root: '/r/${PLUGIN_DATA}', data: '/d' };

  test('replaces both placeholders, every occurrence, in one pass', () => {
    expect(expandPlaceholders('${PLUGIN_ROOT}/a:${PLUGIN_DATA}/b:${PLUGIN_DATA}', dirs)).toBe(
      '/r/${PLUGIN_DATA}/a:/d/b:/d',
    );
  });

  test('leaves anything else as written and names it', () => {
    const unknown: string[] = [];
    expect(expandPlaceholders('${HOME}/x $PLUGIN_ROOT ${plugin_root}', dirs, unknown)).toBe(
      '${HOME}/x $PLUGIN_ROOT ${plugin_root}',
    );
    expect(unknown).toEqual(['${HOME}', '${plugin_root}']);
  });
});

describe('readMcpConfig: the file as a whole (§7.2.2 rule 2)', () => {
  test('a file that cannot be used disables MCP and says which rule it broke', async () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [undefined, '§7.2.1 mcp.json: type'],
      [[], '§7.2.1 mcp.json: type'],
      [{ mcpServers: {} }, '§7.2.1 $schema: required'],
      [
        { $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: {} },
        '§10.1 $schema',
      ],
      [{ $schema: MCP_SCHEMA_ID }, '§7.2.1 mcpServers: type'],
      [{ $schema: MCP_SCHEMA_ID, mcpServers: [] }, '§7.2.1 mcpServers: type'],
      [
        { $schema: MCP_SCHEMA_ID, mcpServers: {}, servers: {} },
        '§7.2.1 servers: additionalProperties',
      ],
    ];
    for (const [raw, rule] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      const outcome = await read(raw);
      expect(outcome.servers).toEqual([]);
      expect(outcome.notices).toHaveLength(1);
      expect(outcome.notices[0]).toContain(rule);
    }
  });

  test('an empty mcpServers object is valid', async () => {
    expect(await read({ $schema: MCP_SCHEMA_ID, mcpServers: {} })).toEqual({
      servers: [],
      notices: [],
    });
  });
});

describe("readMcpConfig: the specification's examples", () => {
  test('§4.1: paths that start with ./ and stay inside are accepted', async () => {
    const { servers, notices } = await read(MCP_VALID_PATHS);
    expect(notices).toEqual([]);
    expect(servers).toEqual([
      {
        config: {
          id: 'server',
          transport: 'stdio',
          command: join(root, 'bin', 'server'),
          args: [],
          env: [],
          url: undefined,
        },
        launch: { env: { PLUGIN_ROOT: root, PLUGIN_DATA: data }, cwd: join(root, 'data') },
      },
    ]);
  });

  test('§4.1: ../bin/server and a bare cwd are refused', async () => {
    const { servers, notices } = await read(MCP_INVALID_PATHS);
    expect(servers).toEqual([]);
    expect(notices.join('\n')).toContain('"server"');
    expect(await skipped({ type: 'stdio', command: '../bin/server' })).toContain(
      '§7.2.1 command: single token',
    );
    expect(await skipped({ type: 'stdio', command: 'npx', cwd: 'data' })).toContain(
      '§7.2.1 cwd: pattern',
    );
  });

  test('§7.2.1: stdio and streamable-http load, sse is skipped as unsupported', async () => {
    const { servers, notices } = await read(MCP_ALL_TRANSPORTS);
    expect(servers.map((server) => server.config.id)).toEqual([
      'local-validator',
      'deployment-api',
    ]);
    const [local, remote] = servers;
    expect(local?.config.args).toEqual(['--data', `${data}/validator`]);
    expect(local?.launch).toEqual({
      env: { CONFIG: `${root}/config.json`, PLUGIN_ROOT: root, PLUGIN_DATA: data },
      cwd: root,
    });
    expect(remote).toEqual({
      config: {
        id: 'deployment-api',
        transport: 'http',
        command: undefined,
        args: [],
        env: [],
        url: 'https://deploy.example.com/mcp',
      },
      launch: { headers: { 'X-Tenant': 'public-tenant' } },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('"legacy-events"');
    expect(notices[0]).toContain('sse');
  });

  test('§9.2: a bare command is kept and the placeholders are expanded', async () => {
    const { servers } = await read(MCP_EXPANSION);
    expect(servers[0]?.config.command).toBe('npx');
    expect(servers[0]?.config.args).toEqual(['--config', `${root}/config/db.json`]);
    expect(servers[0]?.launch.env).toEqual({
      DATA_DIR: `${data}/database`,
      PLUGIN_ROOT: root,
      PLUGIN_DATA: data,
    });
  });
});

describe('readMcpConfig: one entry (§7.2.2 rule 3)', () => {
  test('a bad entry is skipped alone', async () => {
    const outcome = await read({
      $schema: MCP_SCHEMA_ID,
      mcpServers: { bad: { type: 'carrier-pigeon' }, good: { type: 'stdio', command: 'npx' } },
    });
    expect(outcome.servers.map((server) => server.config.id)).toEqual(['good']);
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]).toContain('"bad"');
    expect(outcome.notices[0]).toContain('§7.2.1 type: unknown');
  });

  test('the closed schema of each transport is enforced', async () => {
    expect(await skipped({ command: 'npx' })).toContain('§7.2.1 type: unknown');
    expect(await skipped({ type: 'stdio' })).toContain('§7.2.1 required');
    expect(await skipped({ type: 'stdio', command: 'npx', url: 'https://x.example' })).toContain(
      '§7.2.1 url: false',
    );
    expect(await skipped({ type: 'stdio', command: 'npx', args: [1] })).toContain(
      '§7.2.1 args/0: type',
    );
    expect(
      await skipped({ type: 'streamable-http', url: 'https://x.example', command: 'npx' }),
    ).toContain('§7.2.1 command: false');
  });

  test('command is one token: a bare name or a ./ path inside the plugin', async () => {
    expect(await skipped({ type: 'stdio', command: 'npx -y server' })).toContain(
      'command: single token',
    );
    expect(await skipped({ type: 'stdio', command: '/usr/bin/env' })).toContain(
      'command: single token',
    );
    expect(await skipped({ type: 'stdio', command: './bin/absent' })).toContain(
      '§4.1 command: containment',
    );
    expect(await skipped({ type: 'stdio', command: './linked/tool' })).toContain(
      '§4.1 command: containment',
    );
    expect(await skipped({ type: 'stdio', command: './bin/server' })).toBe('');
  });

  test('env may not set the reserved names (§9.2)', async () => {
    expect(
      await skipped({ type: 'stdio', command: 'npx', env: { PLUGIN_ROOT: '/tmp' } }),
    ).toContain('§7.2.1 env');
  });

  test('cwd stays inside the directory it names', async () => {
    expect(await skipped({ type: 'stdio', command: 'npx', cwd: './linked' })).toContain(
      'cwd: containment',
    );
    expect(
      await skipped({ type: 'stdio', command: 'npx', cwd: '${PLUGIN_ROOT}/../outside' }),
    ).toContain('cwd: containment');
    expect(
      await skipped({ type: 'stdio', command: 'npx', cwd: '${PLUGIN_DATA}/../plugin' }),
    ).toContain('cwd: containment');
    const inData = await read({
      $schema: MCP_SCHEMA_ID,
      mcpServers: { s: { type: 'stdio', command: 'npx', cwd: '${PLUGIN_DATA}/cache' } },
    });
    expect(inData.servers[0]?.launch.cwd).toBe(join(data, 'cache'));
  });

  test('a stdio server needs a plugin directory; a remote one does not', async () => {
    const outcome = await read(
      {
        $schema: MCP_SCHEMA_ID,
        mcpServers: {
          local: { type: 'stdio', command: 'npx' },
          remote: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        },
      },
      null,
    );
    expect(outcome.servers.map((server) => server.config.id)).toEqual(['remote']);
    expect(outcome.notices[0]).toContain('needs a plugin root');
  });

  test('a remote URL is absolute, https unless loopback, without user or fragment', async () => {
    const url = (value: string): Promise<string> =>
      skipped({ type: 'streamable-http', url: value });
    for (const good of [
      'https://api.example.com/mcp',
      'http://localhost:3000/mcp',
      'http://127.0.0.9/mcp',
      'http://[::1]:80/mcp',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      expect(await url(good)).toBe('');
    }
    for (const bad of [
      '/mcp',
      'http://api.example.com/mcp',
      'ftp://example.com/mcp',
      'https://user:pw@example.com/mcp',
      'https://example.com/mcp#x',
      'http://127.example.com/mcp',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      expect(await url(bad)).toContain('§7.2.1 url');
    }
  });

  test('headers are valid and unique whatever their case', async () => {
    const headers = (value: Readonly<Record<string, string>>): Promise<string> =>
      skipped({ type: 'streamable-http', url: 'https://x.example/mcp', headers: value });
    expect(await headers({ 'X-Tenant': 'a', 'x-tenant': 'b' })).toContain('§7.2.1 headers');
    expect(await headers({ 'Bad Name': 'a' })).toContain('§7.2.1 headers');
    expect(await headers({ 'X-A': 'line\nbreak' })).toContain('§7.2.1 headers');
    expect(await headers({ 'X-A': 'a', 'X-B': 'b' })).toBe('');
  });

  test('a ${…} that is not a placeholder is left as written and named', async () => {
    const outcome = await read({
      $schema: MCP_SCHEMA_ID,
      mcpServers: {
        s: { type: 'stdio', command: 'npx', args: ['${HOME}/x', '${HOME}'], env: { A: '${USER}' } },
      },
    });
    expect(outcome.servers[0]?.config.args).toEqual(['${HOME}/x', '${HOME}']);
    expect(outcome.servers[0]?.launch.env?.['A']).toBe('${USER}');
    expect(outcome.notices).toHaveLength(2);
    expect(outcome.notices.join('\n')).toContain('${HOME}');
    expect(outcome.notices.join('\n')).toContain('${USER}');
  });
});
