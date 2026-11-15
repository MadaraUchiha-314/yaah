import { describe, expect, test } from 'bun:test';

import { readCredential } from '../kernel/credentials.ts';
import { ConfigError, YaahError } from '../kernel/errors.ts';
import type { BrowserComposition } from './harness.ts';
import { CONFIG_FILE, pageOptions, startPageHarness } from './start.ts';

const EMPTY: BrowserComposition = { entries: [], prompts: {} };

/** A `fetch` that answers every request the same way and records what was asked. */
function fetcher(status: number, body = ''): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const answer = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    asked.push(typeof input === 'string' ? input : '(not a string)');
    return Promise.resolve(new Response(body, { status, statusText: 'Status Text' }));
  };
  return { fetch: Object.assign(answer, { preconnect: fetch.preconnect }), asked };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('pageOptions', () => {
  test('reads the configuration and the credentials an embedding page set', () => {
    const scope = { yaah: { config: 'locale = "en"', credentials: { KEY: 'k', N: 3 } } };
    expect(pageOptions(scope)).toEqual({ config: 'locale = "en"', credentials: { KEY: 'k' } });
  });

  test('is empty when the page set nothing usable', () => {
    expect(pageOptions({})).toEqual({});
    expect(pageOptions({ yaah: 'no' })).toEqual({});
    expect(pageOptions({ yaah: { config: 3, credentials: 'x' } })).toEqual({});
    expect(pageOptions()).toEqual({});
  });
});

describe('startPageHarness', () => {
  test('fetches config.toml from beside the page and keeps the stores in memory', async () => {
    const { fetch: fake, asked } = fetcher(200, 'data_dir = "/var/lib/yaah"\nlocale = "en"');
    const harness = await startPageHarness(EMPTY, {}, fake);
    expect(asked).toEqual([CONFIG_FILE]);
    expect(harness.ctx.config.dataDir).toBe(':memory:');
    await harness.dispose();
  });

  test('uses the configuration and credentials the page was given, without fetching', async () => {
    const { fetch: fake, asked } = fetcher(500);
    const harness = await startPageHarness(
      EMPTY,
      { config: '[limits]\nmax_iterations = 7', credentials: { KEY: 'k' } },
      fake,
    );
    expect(asked).toEqual([]);
    expect(harness.ctx.config.limits.maxIterations).toBe(7);
    expect(readCredential(harness.ctx, 'KEY')).toBe('k');
    await harness.dispose();
  });

  test('runs on the defaults when the site ships no configuration', async () => {
    const harness = await startPageHarness(EMPTY, {}, fetcher(404).fetch);
    expect(harness.ctx.config.model.llm).toBe('openai/gpt-6.1-sol');
    await harness.dispose();
  });

  test('says why when the configuration cannot be read or is not valid', async () => {
    const unread = await failure(startPageHarness(EMPTY, {}, fetcher(503).fetch));
    expect(unread instanceof YaahError ? unread.code : '').toBe('browser.config');
    expect(unread instanceof Error ? unread.message : '').toContain('503 Status Text');
    const invalid = await failure(startPageHarness(EMPTY, { config: 'no_such_key = 1' }));
    expect(invalid).toBeInstanceOf(ConfigError);
  });
});
