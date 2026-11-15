import { afterEach, describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import { TEST_KEY, answer, collect, replay, sse } from '../../../../../test/support/anthropic.ts';
import { parseConfig } from '../../../../kernel/config.ts';
import { ConfigError } from '../../../../kernel/errors.ts';
import { Redactor } from '../../../../kernel/redactor.ts';
import { EntityRegistry } from '../../../../kernel/registry.ts';
import type { AnthropicPluginConfig } from './index.ts';
import * as plugin from './index.ts';

const ENV = 'YAAH_TEST_ANTHROPIC_KEY';

interface Started {
  readonly registry: EntityRegistry;
  readonly redactor: Redactor;
  readonly dispose: () => Promise<void>;
}

/** Starts the plugin on a bare context carrying the services it injects. */
async function start(llm: string, config?: AnthropicPluginConfig): Promise<Started> {
  const ctx = new Context();
  const registry = new EntityRegistry();
  const redactor = new Redactor();
  ctx.provide('entities', registry);
  ctx.provide('redactor', redactor);
  ctx.provide(
    'config',
    parseConfig(
      [
        '[model]',
        `llm = "${llm}"`,
        '[providers.anthropic]',
        `api_key_env = "${ENV}"`,
        'models = ["claude-haiku-5-5", "claude-next"]',
      ].join('\n'),
      'test.toml',
    ),
  );
  const fiber = await ctx.use((inner: Context) => {
    plugin.apply(inner, config);
  });
  return {
    registry,
    redactor,
    dispose: async (): Promise<void> => {
      await fiber.dispose();
    },
  };
}

afterEach(() => {
  delete process.env[ENV];
});

describe('anthropic plugin', () => {
  test('declares its name and the services it needs', () => {
    expect(plugin.name).toBe('anthropic');
    expect(plugin.inject).toEqual(['entities', 'config', 'redactor']);
  });

  test('registers one llm per configured model and removes them when disposed', async () => {
    process.env[ENV] = TEST_KEY;
    const { registry, redactor, dispose } = await start('anthropic/claude-haiku-5-5');
    expect(registry.list('llm').map((llm) => llm.ref.id)).toEqual([
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-next',
    ]);
    const known = registry.resolve({
      kind: 'llm',
      id: 'anthropic/claude-haiku-5-5',
      version: null,
    });
    const unknown = registry.resolve({ kind: 'llm', id: 'anthropic/claude-next', version: null });
    expect(known.capabilities.maxOutput).toBe(128_000);
    expect(unknown.capabilities.efforts).toEqual([]);
    expect(known.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://api.anthropic.com',
    });
    expect(redactor.redactString(`key=${TEST_KEY}`)).toBe('key=[redacted]');
    await dispose();
    expect(registry.list('llm')).toEqual([]);
  });

  test('takes the key and fetch from its own configuration', async () => {
    const fake = replay(sse(answer('end_turn')));
    const { registry, redactor } = await start('openai/gpt', {
      apiKey: 'explicit-key-0123456789',
      fetch: fake.fetch,
    });
    const llm = registry.resolve({ kind: 'llm', id: 'anthropic/claude-haiku-5-5', version: null });
    const events = await collect(llm, { messages: [], tools: [] });
    expect(events.at(-1)?.type).toBe('done');
    expect(fake.headers[0]?.get('authorization')).toBe('Bearer explicit-key-0123456789');
    expect(redactor.contains('explicit-key-0123456789')).toBe(true);
  });

  test('registers nothing without a key when another provider is the model', async () => {
    const { registry } = await start('openai/gpt');
    expect(registry.list('llm')).toEqual([]);
  });

  test('refuses to start without a key when the model is an Anthropic one', async () => {
    let caught: unknown = null;
    try {
      await start('anthropic/claude-haiku-5-5');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (caught instanceof ConfigError) {
      expect(caught.code).toBe('config.credential');
      expect(caught.file).toBe('config.toml');
      expect(caught.key).toBe('providers.anthropic.api_key_env');
      expect(caught.message).toContain(ENV);
    }
  });
});
