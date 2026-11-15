import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/compositions/browser/', import.meta.url));

/** Runs `bun run build:browser` on a composition, into a directory of its own. */
function build(composition: string): { status: number | null; stderr: string; out: string } {
  const out = mkdtempSync(join(tmpdir(), 'yaah-browser-build-'));
  const run = spawnSync('bun', ['run', 'scripts/build-browser.ts', composition, out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr, out };
}

describe('bun run build:browser', () => {
  /**
   * Feature: Browser build
   * Scenario: A build that includes a node-only plugin fails by name
   *   Given a browser composition that includes the HTTP listener
   *   When `bun run build:browser` is run on it
   *   Then the build fails, names the entry and its module, and writes no site
   * Requirement: docs/specs/issue-3/requirements.md R25.3
   */
  test('A build that includes a node-only plugin fails by name', () => {
    const result = build(join(FIXTURES, 'with-http.yml'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Entry http names "../../app/http.ts"');
    expect(result.stderr).toContain('runs on node only');
    expect(existsSync(join(result.out, 'index.html'))).toBe(false);
  }, 60_000);

  /**
   * Feature: Browser build
   * Scenario: A plugin that needs Node without saying so still fails the build by name
   *   Given a browser composition with a plugin that declares no runtime and imports node:fs
   *   When `bun run build:browser` is run on it
   *   Then the build fails, naming the entry, the module, the builtin and the import chain
   * Requirement: docs/specs/issue-3/requirements.md R25.3
   */
  test('A plugin that needs Node without saying so fails the build by name', () => {
    const result = build(join(FIXTURES, 'with-undeclared.yml'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Entry reads-files names "../../plugins/reads-files.ts"');
    expect(result.stderr).toContain('imports node:fs through test/fixtures/plugins/reads-files.ts');
    expect(existsSync(join(result.out, 'index.html'))).toBe(false);
  }, 60_000);
});
