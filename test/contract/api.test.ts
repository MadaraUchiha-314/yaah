import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { API_MANIFEST_PATH, apiManifest } from '../../scripts/api.ts';
import { serializeSpec } from '../../src/kernel/specs.ts';

/**
 * Feature: CLI, SDK and configuration
 * Scenario: The package's export list is a reviewed contract
 *   Given the checked-in list of every subpath and the names it exports
 *   When the list is generated again from the source
 *   Then the two are equal
 * Requirement: docs/specs/issue-3/requirements.md R22.6, R26.7
 */
test('The package exports exactly what specs/api/exports.json lists', async () => {
  const path = fileURLToPath(new URL(`../../${API_MANIFEST_PATH}`, import.meta.url));
  // A difference means the public API changed. If that is intended, run
  // `bun run specs:update` and review the diff as an interface change.
  expect(await readFile(path, 'utf8')).toBe(serializeSpec(await apiManifest()));
});

test('the root exports what a developer needs to build a harness', async () => {
  const root = (await apiManifest())['.'] ?? [];
  for (const name of ['createHarness', 'loadConfig', 'defineTool', 'HarnessSession', 'runCli']) {
    expect(root).toContain(name);
  }
});
