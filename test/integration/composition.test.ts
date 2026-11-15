import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { bootstrap } from '../../src/kernel/bootstrap.ts';
import { PluginLoadError } from '../../src/kernel/errors.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/compositions/${name}`, import.meta.url));
const plugin = (name: string): string =>
  new URL(`../fixtures/plugins/${name}`, import.meta.url).href;

const FIXTURE_PROMPT = { kind: 'prompt', id: 'fixture', version: null } as const;

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('composition', () => {
  /**
   * Feature: Plugin kernel and composition
   * Scenario: A root composition includes a shared file
   *   Given a root cordis.yaml that includes a shared YAML file
   *   When the harness starts from the root file
   *   Then the plugin declared in the shared file is running with its configuration
   * Requirement: docs/specs/issue-3/requirements.md R1.1, R1.2
   */
  test('A root composition includes a shared file', async () => {
    const harness = await bootstrap({ root: fixture('root.yml') });
    expect(harness.ctx.entities.resolve(FIXTURE_PROMPT).template).toBe('from shared file');
    await harness.dispose();
  });

  /**
   * Feature: Plugin kernel and composition
   * Scenario: A composition replaces a default plugin by id
   *   Given a shared composition whose entry "fixture" loads the default plugin
   *   When the operator overrides the entry "fixture" with another plugin
   *   Then the operator's plugin is loaded in place of the default
   * Requirement: docs/specs/issue-3/requirements.md R1.3
   */
  test('A composition replaces a default plugin by id', async () => {
    const harness = await bootstrap({
      root: fixture('root.yml'),
      overrides: [{ id: 'fixture', name: plugin('tool-b.ts') }],
    });
    expect(harness.ctx.entities.resolve(FIXTURE_PROMPT).template).toBe('replacement B');
    await harness.dispose();
  });

  /**
   * Feature: Plugin kernel and composition
   * Scenario: An override changes only the configuration of a default plugin
   *   Given a shared composition whose entry "fixture" has a configuration
   *   When the operator overrides the configuration of the entry "fixture"
   *   Then the default plugin runs with the operator's configuration
   * Requirement: docs/specs/issue-3/requirements.md R1.3
   */
  test('An override changes only the configuration of a default plugin', async () => {
    const harness = await bootstrap({
      root: fixture('root.yml'),
      overrides: [{ id: 'fixture', config: { text: 'from operator' } }],
    });
    expect(harness.ctx.entities.resolve(FIXTURE_PROMPT).template).toBe('from operator');
    await harness.dispose();
  });

  /**
   * Feature: Plugin kernel and composition
   * Scenario: A plugin that fails to load stops start-up and is named
   *   Given a composition with an entry whose plugin throws while starting
   *   When the harness starts
   *   Then start-up fails with an error naming the entry, the plugin and the cause
   * Requirement: docs/specs/issue-3/requirements.md R1.4
   */
  test('A plugin that fails to load stops start-up and is named', async () => {
    const error = await failure(() => bootstrap({ root: fixture('throws.yml') }));
    expect(error).toBeInstanceOf(PluginLoadError);
    if (error instanceof PluginLoadError) {
      expect(error.entryId).toBe('broken');
      expect(error.pluginName).toBe('../plugins/throws.ts');
      expect(error.message).toContain('boom from fixture');
    }
  });

  /**
   * Feature: Plugin kernel and composition
   * Scenario: A plugin that cannot be found stops start-up and is named
   *   Given a composition with an entry naming a module that does not exist
   *   When the harness starts
   *   Then start-up fails with an error naming the entry and the plugin
   * Requirement: docs/specs/issue-3/requirements.md R1.4
   */
  test('A plugin that cannot be found stops start-up and is named', async () => {
    const error = await failure(() => bootstrap({ root: fixture('missing.yml') }));
    expect(error).toBeInstanceOf(PluginLoadError);
    if (error instanceof PluginLoadError) {
      expect(error.entryId).toBe('ghost');
    }
  });

  /**
   * Feature: Plugin kernel and composition
   * Scenario: Disposing a plugin removes what it registered
   *   Given a running harness whose plugin registered an entity
   *   When the harness is disposed
   *   Then the entity is no longer registered
   * Requirement: docs/specs/issue-3/requirements.md R1.5
   */
  test('Disposing a plugin removes what it registered', async () => {
    const harness = await bootstrap({ root: fixture('root.yml') });
    const { entities } = harness.ctx;
    expect(entities.has(FIXTURE_PROMPT)).toBe(true);
    await harness.dispose();
    expect(entities.has(FIXTURE_PROMPT)).toBe(false);
  });
});
