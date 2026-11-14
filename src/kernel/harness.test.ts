import { describe, expect, test } from 'bun:test';

import { renderPrompt } from '../harness/system-prompt/prompt.ts';
import { defaultConfig, parseConfig } from './config.ts';
import { YaahError } from './errors.ts';
import { createHarness, resolveComposition } from './harness.ts';

describe('resolveComposition', () => {
  test('maps a shipped build name to its file', () => {
    expect(resolveComposition('cli').endsWith('compositions/cli.yml')).toBe(true);
    expect(resolveComposition('server').endsWith('compositions/server.yml')).toBe(true);
  });

  test('resolves a relative path against the working directory', () => {
    expect(resolveComposition('./mine/cordis.yaml', '/srv/app')).toBe('/srv/app/mine/cordis.yaml');
  });

  test('keeps an absolute path', () => {
    expect(resolveComposition('/etc/yaah/cordis.yml')).toBe('/etc/yaah/cordis.yml');
  });

  test('rejects an unknown build name', () => {
    expect(() => resolveComposition('nope')).toThrow(YaahError);
  });
});

describe('createHarness', () => {
  test('starts the cli composition with the default configuration', async () => {
    const harness = await createHarness();
    expect(harness.ctx.config).toEqual(defaultConfig());
    expect(harness.ctx.strings.t('error.plugin.missing')).not.toBe('error.plugin.missing');
    await harness.dispose();
  });

  test('registers the shipped prompts, and the system prompt is minimal', async () => {
    const harness = await createHarness();
    const ids = harness.ctx.entities.list('prompt').map((prompt) => prompt.ref.id);
    expect(ids).toEqual(['roles', 'system', 'untrusted-data']);
    const system = renderPrompt(harness.ctx.entities, 'system', {});
    expect(system).toContain('ask_user');
    expect(system).toContain('data supplied by third parties');
    expect(system.length).toBeLessThan(1500);
    await harness.dispose();
  });

  test('an override from the configuration disables a default plugin', async () => {
    const config = parseConfig('[[overrides]]\nid = "system-prompt"\ndisabled = true\n', 'c.toml');
    const harness = await createHarness({ config });
    expect(harness.ctx.entities.list('prompt')).toEqual([]);
    await harness.dispose();
  });
});
