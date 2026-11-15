/**
 * The OpenAI System One plugin: what it registers from the configuration, how it treats
 * a missing credential, and that the key it reads is handed to the redactor.
 */
import { describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import * as plugin from '../../src/harness/models/system-one/openai/index.ts';
import type { YaahConfig } from '../../src/kernel/config-types.ts';
import { defaultConfig, parseConfig } from '../../src/kernel/config.ts';
import { ConfigError } from '../../src/kernel/errors.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { EntityRegistry } from '../../src/kernel/registry.ts';
import { json, replay } from '../support/llm-http.ts';

const KEY = 'sk-fixture-secret-key-0002';
const ENV = 'YAAH_TEST_SYSTEM_ONE_KEY';

interface Fixture {
  readonly ctx: Context;
  readonly registry: EntityRegistry;
  readonly redactor: Redactor;
}

function harness(config: YaahConfig): Fixture {
  const ctx = new Context();
  const registry = new EntityRegistry();
  const redactor = new Redactor();
  ctx.provide('entities', registry);
  ctx.provide('config', config);
  ctx.provide('redactor', redactor);
  return { ctx, registry, redactor };
}

function configured(extra = ''): YaahConfig {
  return parseConfig(`[providers.openai]\napi_key_env = "${ENV}"\n${extra}`, 'test.toml');
}

function ids(registry: EntityRegistry): string[] {
  return registry.list('system-one').map((model) => model.ref.id);
}

async function withEnv(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const before = process.env[ENV];
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
  try {
    await body();
  } finally {
    if (before === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = before;
    }
  }
}

describe('system-one-openai plugin', () => {
  test('the configuration defaults to gpt-6-luna, and triage to that model', () => {
    const config = defaultConfig();
    expect(config.providers.openai.systemOneModel).toBe('gpt-6-luna');
    expect(config.inbox).toEqual({ triage: 'off', triageModel: 'openai/gpt-6-luna' });
    const other = configured('system_one_model = "gpt-7-luna"\n[inbox]\ntriage = "system-one"');
    expect(other.inbox).toEqual({ triage: 'system-one', triageModel: 'openai/gpt-7-luna' });
  });

  test('registers the configured model with the key from the environment', async () => {
    await withEnv(KEY, async () => {
      const http = replay(
        json(
          200,
          JSON.stringify({
            model: 'gpt-7-luna',
            answers: [{ type: 'predicate', name: 'q', probability: 0.7 }],
            usage: {},
          }),
        ),
      );
      const { ctx, registry, redactor } = harness(
        configured('system_one_model = "gpt-7-luna"\nbase_url = "https://proxy.example/v1"'),
      );
      await ctx.use(plugin, { fetch: http.fetch });
      expect(ids(registry)).toEqual(['openai/gpt-7-luna']);
      expect(redactor.contains(`Bearer ${KEY}`)).toBe(true);
      const model = registry.resolve({
        kind: 'system-one',
        id: 'openai/gpt-7-luna',
        version: null,
      });
      const answers = await model.decide(
        { text: 'x' },
        [{ type: 'predicate', id: 'q', text: 'Is it?' }],
        new AbortController().signal,
      );
      expect(answers).toEqual([{ type: 'predicate', id: 'q', probability: 0.7 }]);
      expect(http.requests[0]?.url).toBe('https://proxy.example/v1/decisions');
      expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    });
  });

  test('a key in the plugin configuration wins over the environment', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry, redactor } = harness(configured());
      await ctx.use(plugin, { apiKey: KEY });
      expect(ids(registry)).toEqual(['openai/gpt-6-luna']);
      expect(redactor.contains(KEY)).toBe(true);
    });
  });

  test('without a key it registers nothing and says so once the harness is ready', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured());
      const said: string[][] = [];
      ctx.on('system-one/unavailable', (id: string, variable: string) => {
        said.push([id, variable]);
      });
      await ctx.use(plugin, undefined);
      expect(ids(registry)).toEqual([]);
      await ctx.parallel('harness/ready');
      expect(said).toEqual([['openai/gpt-6-luna', ENV]]);
    });
  });

  test('without a key it refuses to start when inbox triage uses this model', async () => {
    await withEnv(undefined, async () => {
      const { ctx } = harness(configured('[inbox]\ntriage = "system-one"'));
      let caught: unknown = null;
      try {
        await ctx.use(plugin, undefined);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect(caught instanceof ConfigError && caught.code).toBe('config.credential');
      expect(caught instanceof ConfigError && caught.key).toBe('providers.openai.api_key_env');
      expect(caught instanceof Error ? caught.message : '').toContain(ENV);
    });
  });

  test('without a key it starts when triage asks another model', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(
        configured('[inbox]\ntriage = "system-one"\ntriage_model = "mine/fast"'),
      );
      await ctx.use(plugin, undefined);
      expect(ids(registry)).toEqual([]);
    });
  });
});
