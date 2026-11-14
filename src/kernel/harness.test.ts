import { describe, expect, test } from 'bun:test';

import { renderPrompt } from '../harness/system-prompt/prompt.ts';
import { defaultConfig, parseConfig } from './config.ts';
import { YaahError } from './errors.ts';
import { createHarness, resolveComposition } from './harness.ts';

/** A configuration that touches neither the user's data directory nor a fixed port. */
function quiet(extra = ''): ReturnType<typeof parseConfig> {
  return parseConfig(`data_dir = ":memory:"\n[server]\nport = 0\n${extra}`, 'c.toml');
}

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
  test('starts the cli composition from a configuration', async () => {
    const harness = await createHarness({ config: quiet() });
    expect(harness.ctx.config.limits).toEqual(defaultConfig().limits);
    expect(harness.ctx.strings.t('error.plugin.missing')).not.toBe('error.plugin.missing');
    await harness.dispose();
  });

  test('registers the shipped prompts, and the system prompt is minimal', async () => {
    const harness = await createHarness({ config: quiet() });
    const ids = harness.ctx.entities.list('prompt').map((prompt) => prompt.ref.id);
    expect(ids).toEqual([
      'compaction',
      'plan',
      'roles',
      'summary',
      'system',
      'task',
      'untrusted-data',
    ]);
    const system = renderPrompt(harness.ctx.entities, 'system', {});
    expect(system).toContain('ask_user');
    expect(system).toContain('data supplied by third parties');
    expect(system.length).toBeLessThan(1500);
    await harness.dispose();
  });

  test('an override from the configuration disables a default plugin', async () => {
    const config = quiet('[[overrides]]\nid = "system-prompt"\ndisabled = true\n');
    const harness = await createHarness({ config });
    expect(harness.ctx.entities.list('prompt')).toEqual([]);
    await harness.dispose();
  });
});
