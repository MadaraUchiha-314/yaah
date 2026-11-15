import { describe, expect, test } from 'bun:test';
import type { Context } from 'cordis';

import { parseConfig } from '../kernel/config.ts';
import { readCredential } from '../kernel/credentials.ts';
import { PluginLoadError, YaahError } from '../kernel/errors.ts';
import { REDACTED } from '../kernel/redactor.ts';
import type { BrowserComposition, BrowserEntry } from './harness.ts';
import { createBrowserHarness } from './harness.ts';
import * as prompts from './plugins/prompts.ts';

declare module 'cordis' {
  interface Context {
    /** A service of this test's plugins. */
    marker: string;
  }
}

const order: string[] = [];

function plugin(label: string, extra: Partial<BrowserEntry['plugin']> = {}): BrowserEntry {
  return {
    id: label,
    name: `./${label}.ts`,
    plugin: {
      name: label,
      apply: (_ctx: Context, config: unknown): void => {
        order.push(`${label}:${JSON.stringify(config)}`);
      },
      ...extra,
    },
  };
}

const compose = (...entries: BrowserEntry[]): BrowserComposition => ({
  entries,
  prompts: { system: 'You are {{name}}.', task: 'Do it.' },
});

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('createBrowserHarness', () => {
  test('starts the entries in order with the kernel services, then setup, then ready', async () => {
    order.length = 0;
    const harness = await createBrowserHarness({
      composition: compose(
        { id: 'system-prompt', name: '../browser/plugins/prompts.ts', plugin: prompts },
        { ...plugin('a'), config: { n: 1 } },
        plugin('b'),
      ),
      credentials: { MODEL_KEY: 'sk-browser-secret' },
      setup: (ctx) => {
        order.push('setup');
        ctx.on('harness/ready', () => {
          order.push('ready');
          return Promise.resolve();
        });
      },
    });
    expect(order).toEqual(['a:{"n":1}', 'b:undefined', 'setup', 'ready']);
    const { ctx } = harness;
    expect(ctx.config.dataDir).toBe(':memory:');
    expect(ctx.strings.t('error.plugin.missing')).not.toBe('error.plugin.missing');
    expect(readCredential(ctx, 'MODEL_KEY')).toBe('sk-browser-secret');
    expect(ctx.redactor.redact('key sk-browser-secret')).toBe(`key ${REDACTED}`);
    const system = ctx.entities.resolve({ kind: 'prompt', id: 'system', version: null });
    expect(system.render({ name: 'yaah' })).toBe('You are yaah.');
    expect(ctx.entities.has({ kind: 'prompt', id: 'task', version: null })).toBe(true);
    await harness.dispose();
  });

  test('a credential that was not given is read from the environment, where there is one', async () => {
    const harness = await createBrowserHarness({ composition: compose() });
    process.env['YAAH_TEST_BROWSER_KEY'] = 'from-env';
    expect(readCredential(harness.ctx, 'YAAH_TEST_BROWSER_KEY')).toBe('from-env');
    delete process.env['YAAH_TEST_BROWSER_KEY'];
    expect(readCredential(harness.ctx, 'YAAH_TEST_BROWSER_KEY')).toBeUndefined();
    await harness.dispose();
  });

  test('names the entry whose plugin throws, and leaves nothing running', async () => {
    let disposed = false;
    const tidy = plugin('tidy', {
      apply: (ctx: Context): void => {
        ctx.effect(() => (): void => {
          disposed = true;
        });
      },
    });
    const broken = plugin('broken', {
      apply: (): void => {
        throw new Error('no such API here');
      },
    });
    const error = await failure(createBrowserHarness({ composition: compose(tidy, broken) }));
    expect(error).toBeInstanceOf(PluginLoadError);
    if (error instanceof PluginLoadError) {
      expect([error.entryId, error.pluginName]).toEqual(['broken', './broken.ts']);
      expect(error.message).toContain('no such API here');
    }
    expect(disposed).toBe(true);
  });

  test('names the entry that waits for a service nothing provides', async () => {
    const waiting = plugin('waiting', { inject: ['entities', 'marker'] });
    const error = await failure(createBrowserHarness({ composition: compose(waiting) }));
    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error instanceof PluginLoadError ? error.entryId : '').toBe('waiting');
    expect(error instanceof Error ? error.message : '').toContain('provides: marker');
  });

  test('an entry may wait for a service a later entry provides', async () => {
    order.length = 0;
    const provider = plugin('provider', {
      apply: (ctx: Context): void => {
        ctx.provide('marker', 'here');
      },
    });
    const harness = await createBrowserHarness({
      composition: compose(plugin('early', { inject: ['marker'] }), provider),
    });
    expect(order).toEqual(['early:undefined']);
    await harness.dispose();
  });

  test('an override reconfigures or disables an entry, but cannot replace its plugin', async () => {
    order.length = 0;
    const toml = (extra: string): ReturnType<typeof parseConfig> =>
      parseConfig(`data_dir = ":memory:"\n${extra}`, 'c.toml');
    const config = toml(
      '[[overrides]]\nid = "a"\nconfig = { n = 2 }\n[[overrides]]\nid = "b"\ndisabled = true',
    );
    const harness = await createBrowserHarness({
      composition: compose({ ...plugin('a'), config: { n: 1 } }, plugin('b'), plugin('c')),
      config,
    });
    expect(order).toEqual(['a:{"n":2}', 'c:undefined']);
    await harness.dispose();

    const replaced = toml('[[overrides]]\nid = "a"\nname = "./mine.ts"');
    const error = await failure(
      createBrowserHarness({ composition: compose(plugin('a')), config: replaced }),
    );
    expect(error instanceof YaahError ? error.code : '').toBe('browser.override-name');
    expect(error instanceof Error ? error.message : '').toContain('./mine.ts');
  });
});
