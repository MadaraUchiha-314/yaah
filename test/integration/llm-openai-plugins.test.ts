/**
 * The two OpenAI plugins: which `llm` entities they register from the configuration, how
 * they treat a missing credential, and that a key they read is handed to the redactor.
 */
import { describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import * as compatiblePlugin from '../../src/harness/models/llm/openai-compatible/index.ts';
import * as openaiPlugin from '../../src/harness/models/llm/openai/index.ts';
import type { YaahConfig } from '../../src/kernel/config-types.ts';
import { defaultConfig } from '../../src/kernel/config.ts';
import { ConfigError } from '../../src/kernel/errors.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { EntityRegistry } from '../../src/kernel/registry.ts';
import { collect, fixture, replay, sse } from '../support/llm-http.ts';

const KEY = 'sk-fixture-secret-key-0001';
const ENV = 'YAAH_TEST_LLM_KEY';
const HI = {
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }],
  tools: [],
};

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

function configured(change: {
  llm?: string;
  openai?: Partial<YaahConfig['providers']['openai']>;
  compatible?: YaahConfig['providers']['compatible'];
}): YaahConfig {
  const base = defaultConfig();
  return {
    ...base,
    model: { ...base.model, llm: change.llm ?? 'scripted/model' },
    providers: {
      ...base.providers,
      openai: { ...base.providers.openai, apiKeyEnv: ENV, ...change.openai },
      compatible: change.compatible ?? [],
    },
  };
}

function ids(registry: EntityRegistry): string[] {
  return registry.list('llm').map((llm) => llm.ref.id);
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

async function startFailure(start: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await start();
  } catch (error) {
    return error;
  }
  return null;
}

describe('llm-openai plugin', () => {
  test('declares its name and the services it needs', () => {
    expect(openaiPlugin.name).toBe('llm-openai');
    expect([...openaiPlugin.inject].toSorted()).toEqual(['config', 'entities', 'redactor']);
  });

  test('registers one entity per configured model, with built-in capabilities', async () => {
    await withEnv(KEY, async () => {
      const { ctx, registry, redactor } = harness(
        configured({ openai: { models: ['gpt-6.1-sol', 'gpt-experimental'] } }),
      );
      const fiber = await ctx.use(openaiPlugin, undefined);
      expect(ids(registry)).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-experimental']);
      const sol = registry.resolve({ kind: 'llm', id: 'openai/gpt-6.1-sol', version: null });
      expect(sol.capabilities).toEqual({
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        input: ['image'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
      expect(sol.locality).toEqual({
        type: 'remote',
        protocol: 'https',
        url: 'https://api.openai.com/v1',
      });
      const unknown = registry.resolve({
        kind: 'llm',
        id: 'openai/gpt-experimental',
        version: null,
      });
      expect(unknown.capabilities).toEqual({
        contextWindow: 128_000,
        maxOutput: 16_384,
        input: [],
        efforts: [],
      });
      expect(redactor.contains(`Bearer ${KEY}`)).toBe(true);
      await fiber.dispose();
      expect(ids(registry)).toEqual([]);
    });
  });

  test('gives the same capabilities to every model of the built-in table', async () => {
    await withEnv(KEY, async () => {
      const { ctx, registry } = harness(configured({}));
      await ctx.use(openaiPlugin, undefined);
      const models = registry.list('llm');
      expect(models.map((llm) => llm.ref.id)).toEqual([
        'openai/gpt-6-astra',
        'openai/gpt-6.1-sol',
        'openai/gpt-6.1-terra',
      ]);
      expect(new Set(models.map((llm) => JSON.stringify(llm.capabilities))).size).toBe(1);
    });
  });

  test('uses the injected key, fetch and the configured base URL', async () => {
    await withEnv(undefined, async () => {
      const http = replay(sse(fixture('openai/text.sse')));
      const { ctx, registry, redactor } = harness(
        configured({ openai: { models: ['gpt-6.1-sol'], baseUrl: 'https://proxy.example/v1' } }),
      );
      await ctx.use(openaiPlugin, { apiKey: KEY, fetch: http.fetch });
      const llm = registry.resolve({ kind: 'llm', id: 'openai/gpt-6.1-sol', version: null });
      await collect(llm, HI);
      expect(http.requests[0]?.url).toBe('https://proxy.example/v1/responses');
      expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(redactor.contains(KEY)).toBe(true);
    });
  });

  test('registers nothing when the key is not set and another provider is the default', async () => {
    for (const value of [undefined, '']) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      await withEnv(value, async () => {
        const { ctx, registry } = harness(configured({ llm: 'anthropic/some-model' }));
        await ctx.use(openaiPlugin, undefined);
        expect(ids(registry)).toEqual([]);
      });
    }
  });

  test('fails with a ConfigError when the key is not set and OpenAI is the default', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured({ llm: 'openai/gpt-6.1-sol' }));
      const error = await startFailure(() => ctx.use(openaiPlugin, undefined));
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.code).toBe('config.credential');
        expect(error.key).toBe('providers.openai.api_key_env');
        expect(error.file).toBe('config.toml');
        expect(error.message).toContain(ENV);
      }
      expect(ids(registry)).toEqual([]);
    });
  });
});

describe('llm-openai-compatible plugin', () => {
  const ollama = {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: undefined,
    models: ['llama4', 'qwen4'],
    contextWindow: 32_000,
    maxOutput: 4096,
  };
  const router = {
    id: 'router',
    baseUrl: 'https://openrouter.example/api/v1',
    apiKeyEnv: ENV,
    models: ['vendor/model-1'],
    contextWindow: 200_000,
    maxOutput: 8192,
  };

  test('declares its name and the services it needs', () => {
    expect(compatiblePlugin.name).toBe('llm-openai-compatible');
    expect([...compatiblePlugin.inject].toSorted()).toEqual(['config', 'entities', 'redactor']);
  });

  test('registers one entity per model of every endpoint, with the configured limits', async () => {
    await withEnv(KEY, async () => {
      const { ctx, registry, redactor } = harness(configured({ compatible: [ollama, router] }));
      const fiber = await ctx.use(compatiblePlugin, undefined);
      expect(ids(registry)).toEqual(['ollama/llama4', 'ollama/qwen4', 'router/vendor/model-1']);
      const model = registry.resolve({ kind: 'llm', id: 'router/vendor/model-1', version: null });
      expect(model.capabilities).toEqual({
        contextWindow: 200_000,
        maxOutput: 8192,
        input: [],
        efforts: [],
      });
      expect(model.locality).toEqual({ type: 'remote', protocol: 'https', url: router.baseUrl });
      expect(redactor.contains(KEY)).toBe(true);
      await fiber.dispose();
      expect(ids(registry)).toEqual([]);
    });
  });

  test('calls a keyless endpoint without a credential, through the injected fetch', async () => {
    await withEnv(undefined, async () => {
      const http = replay(sse(fixture('openai-compatible/text.sse')));
      const { ctx, registry } = harness(configured({ compatible: [ollama] }));
      await ctx.use(compatiblePlugin, { fetch: http.fetch });
      const llm = registry.resolve({ kind: 'llm', id: 'ollama/llama4', version: null });
      await collect(llm, HI);
      expect(http.requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(http.requests[0]?.headers.get('authorization')).toBe(null);
    });
  });

  test('uses a key injected for one endpoint', async () => {
    await withEnv(undefined, async () => {
      const http = replay(sse(fixture('openai-compatible/text.sse')));
      const { ctx, registry, redactor } = harness(configured({ compatible: [router] }));
      await ctx.use(compatiblePlugin, { fetch: http.fetch, apiKeys: { router: KEY } });
      const llm = registry.resolve({ kind: 'llm', id: 'router/vendor/model-1', version: null });
      await collect(llm, HI);
      expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(redactor.contains(KEY)).toBe(true);
    });
  });

  test('skips an endpoint whose key is not set, and keeps the others', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured({ compatible: [router, ollama] }));
      await ctx.use(compatiblePlugin, undefined);
      expect(ids(registry)).toEqual(['ollama/llama4', 'ollama/qwen4']);
    });
  });

  test('fails with a ConfigError when the default model is on an endpoint without its key', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(
        configured({ llm: 'router/vendor/model-1', compatible: [ollama, router] }),
      );
      const error = await startFailure(() => ctx.use(compatiblePlugin, undefined));
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.code).toBe('config.credential');
        expect(error.key).toBe('providers.compatible[1].api_key_env');
        expect(error.message).toContain(ENV);
      }
      expect(ids(registry)).toEqual([]);
    });
  });
});
