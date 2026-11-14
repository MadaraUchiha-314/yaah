import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG_TOML, defaultConfig, loadConfig, parseConfig } from './config.ts';
import { ConfigError } from './errors.ts';

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yaah-config-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('parseConfig', () => {
  test('an empty file yields the documented defaults', () => {
    const config = parseConfig('', 'config.toml');
    expect(config).toEqual(defaultConfig());
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.durable.mode).toBe('none');
    expect(config.limits.maxIterations).toBe(50);
  });

  test('the shipped default file parses to the defaults', () => {
    expect(parseConfig(DEFAULT_CONFIG_TOML, 'config.toml')).toEqual(defaultConfig());
  });

  test('the shipped default file contains no secret value', () => {
    expect(DEFAULT_CONFIG_TOML).toContain('api_key_env = "OPENAI_API_KEY"');
    expect(DEFAULT_CONFIG_TOML).not.toMatch(/sk-[A-Za-z0-9]/u);
  });

  test('values in the file replace defaults key by key', () => {
    const config = parseConfig('[server]\nport = 9000\n', 'config.toml');
    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe('127.0.0.1');
  });

  test('an unknown key is an error naming the file and the key', () => {
    let caught: unknown = null;
    try {
      parseConfig('[server]\nprot = 9000\n', '/etc/yaah.toml');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (caught instanceof ConfigError) {
      expect(caught.file).toBe('/etc/yaah.toml');
      expect(caught.key).toBe('server.prot');
      expect(caught.code).toBe('config.invalid');
    }
  });

  test('a value of the wrong type is an error naming the key', () => {
    let caught: unknown = null;
    try {
      parseConfig('[limits]\nmax_iterations = "many"\n', 'c.toml');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (caught instanceof ConfigError) {
      expect(caught.key).toBe('limits.max_iterations');
    }
  });

  test('invalid TOML is an error naming the file', () => {
    let caught: unknown = null;
    try {
      parseConfig('this is = = not toml', 'c.toml');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (caught instanceof ConfigError) {
      expect(caught.code).toBe('config.parse');
    }
  });

  test('overrides, MCP servers and agents are read as lists', () => {
    const config = parseConfig(
      [
        '[[overrides]]',
        'id = "llm-openai"',
        'disabled = true',
        '[[mcp.servers]]',
        'id = "orders"',
        'transport = "stdio"',
        'command = "orders-mcp"',
        '[[agents]]',
        'id = "billing"',
        'card_url = "https://billing.example/.well-known/agent-card.json"',
      ].join('\n'),
      'c.toml',
    );
    expect(config.overrides).toEqual([{ id: 'llm-openai', disabled: true }]);
    expect(config.mcp.servers[0]?.id).toBe('orders');
    expect(config.agents[0]?.cardUrl).toBe('https://billing.example/.well-known/agent-card.json');
  });
});

describe('loadConfig', () => {
  test('creates the default file with owner-only permissions when it is missing', async () => {
    const loaded = await loadConfig({ home });
    const file = join(home, '.yaah', 'config.toml');
    expect(loaded.file).toBe(file);
    expect(loaded.created).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(DEFAULT_CONFIG_TOML);
    // oxlint-disable-next-line no-bitwise -- reading permission bits
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(loaded.config).toEqual(defaultConfig());
  });

  test('reads an existing default file without rewriting it', async () => {
    await loadConfig({ home });
    const file = join(home, '.yaah', 'config.toml');
    await writeFile(file, '[server]\nport = 8111\n');
    const loaded = await loadConfig({ home });
    expect(loaded.created).toBe(false);
    expect(loaded.config.server.port).toBe(8111);
  });

  test('an explicit path wins over the default file and is never created', async () => {
    const explicit = join(home, 'mine.toml');
    await writeFile(explicit, 'locale = "fr"\n');
    const loaded = await loadConfig({ home, path: explicit });
    expect(loaded.file).toBe(explicit);
    expect(loaded.config.locale).toBe('fr');
  });

  test('a missing explicit path is an error naming the file', async () => {
    const error = await failure(() => loadConfig({ home, path: join(home, 'absent.toml') }));
    expect(error).toBeInstanceOf(ConfigError);
    if (error instanceof ConfigError) {
      expect(error.code).toBe('config.read');
      expect(error.file).toBe(join(home, 'absent.toml'));
    }
  });
});
