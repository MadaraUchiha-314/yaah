import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { YaahError } from '../../kernel/errors.ts';
import type { ResolvedEntry } from './resolve.ts';
import {
  BrowserBuildError,
  compositionModuleSource,
  loadBrowserComposition,
  loadBrowserEntries,
  readPrompts,
  resolveBrowserComposition,
} from './resolve.ts';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const FIXTURES = at('../../../test/fixtures/compositions/browser/');
const BROWSER_YML = at('../../compositions/browser.yml');
const PROMPTS = at('../../prompts');

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('resolveBrowserComposition', () => {
  test('flattens the shipped browser composition, includes and all, in order', async () => {
    const entries = await resolveBrowserComposition(BROWSER_YML);
    expect(entries.map((entry) => entry.id)).toEqual([
      'system-prompt',
      'core',
      'llm-openai',
      'llm-anthropic',
      'llm-openai-compatible',
      'system-one-openai',
      'runtime',
      'durable',
      'api-server',
      'heartbeat',
      'channels-api',
      'harness-target',
      'commands',
      'a2a-agents',
      'tools-mcp',
      'channels',
      'hooks',
    ]);
    const core = entries.find((entry) => entry.id === 'core');
    expect(core?.module).toBe(at('../plugins/core.ts'));
    const runtime = entries.find((entry) => entry.id === 'runtime');
    expect(runtime?.name).toBe('../../app/runtime.ts');
    expect(runtime?.module).toBe(at('../../app/runtime.ts'));
    expect(runtime?.declaredIn).toBe(at('../../compositions/shared/app.yml'));
  });

  test('keeps configuration, skips a disabled entry and leaves a package name as it is', async () => {
    const entries = await resolveBrowserComposition(`${FIXTURES}nested.yml`);
    expect(entries.map((entry) => [entry.id, entry.config])).toEqual([
      ['first', { text: 'from the root' }],
      ['second', undefined],
      ['packaged', undefined],
    ]);
    expect(entries.at(-1)?.module).toBe('@example/yaah-plugin');
  });

  test('refuses an include with patches, naming the entry', async () => {
    const error = await failure(resolveBrowserComposition(`${FIXTURES}patched.yml`));
    expect(error).toBeInstanceOf(BrowserBuildError);
    expect(error instanceof BrowserBuildError ? [error.code, error.entryId] : []).toEqual([
      'browser.include',
      'layer',
    ]);
  });

  test('refuses a file that is not a list of entries', async () => {
    const error = await failure(resolveBrowserComposition(`${FIXTURES}not-a-list.yml`));
    expect(error instanceof YaahError ? error.code : '').toBe('browser.composition');
    expect(error instanceof Error ? error.message : '').toContain('not-a-list.yml');
  });
});

describe('loadBrowserEntries', () => {
  /**
   * Feature: Browser build
   * Scenario: A build that includes a node-only plugin fails by name
   *   Given a browser composition that includes the HTTP listener
   *   When the build resolves it and checks each plugin
   *   Then it fails, and the error names the entry's id and the module
   * Requirement: docs/specs/issue-3/requirements.md R25.3
   */
  test('A build that includes a node-only plugin fails by name', async () => {
    const entries = await resolveBrowserComposition(`${FIXTURES}with-http.yml`);
    const error = await failure(loadBrowserEntries(entries));
    expect(error).toBeInstanceOf(BrowserBuildError);
    if (!(error instanceof BrowserBuildError)) {
      return;
    }
    expect([error.code, error.entryId, error.module]).toEqual([
      'browser.node-only',
      'http',
      '../../app/http.ts',
    ]);
    expect(error.message).toContain('Entry http names "../../app/http.ts"');
    expect(error.message).toContain('runs on node only');
  });

  test('every shipped plugin that needs Node says so', async () => {
    const nodeOnly = [
      '../../app/http.ts',
      '../../app/o11y/index.ts',
      '../../harness/a2ui/index.ts',
      '../../harness/core/index.ts',
      '../../harness/plugins/index.ts',
      '../../harness/skills/index.ts',
      '../../harness/system-prompt/index.ts',
      '../../surface/renderer/web/server.ts',
    ];
    const refused = await Promise.all(
      nodeOnly.map(async (name) => {
        const entry = { id: 'x', name, module: at(name), declaredIn: at('./x.yml') };
        const error = await failure(loadBrowserEntries([entry]));
        return error instanceof BrowserBuildError ? error.code : name;
      }),
    );
    expect(refused).toEqual(nodeOnly.map(() => 'browser.node-only'));
  });

  test('accepts a plugin that lists the browser, and one that declares nothing', async () => {
    const entry = (id: string): ResolvedEntry => ({
      id,
      name: `@example/${id}`,
      module: `@example/${id}`,
      declaredIn: 'memory.yml',
      config: { level: 1 },
    });
    const apply = (): void => undefined;
    const modules: Record<string, unknown> = {
      both: { apply, name: 'both', inject: ['entities'], runtime: ['node', 'browser'] },
      silent: { apply },
    };
    const loaded = await loadBrowserEntries([entry('both'), entry('silent')], (asked) =>
      Promise.resolve(modules[asked.id]),
    );
    expect(loaded.map((item) => [item.id, item.name, item.plugin.name, item.config])).toEqual([
      ['both', '@example/both', 'both', { level: 1 }],
      ['silent', '@example/silent', undefined, { level: 1 }],
    ]);
    expect(loaded[0]?.plugin.inject).toEqual(['entities']);
    expect(typeof loaded[1]?.plugin.apply).toBe('function');
  });

  test('refuses a module that is not a plugin', async () => {
    const entry = { id: 'odd', name: './odd.ts', module: '/odd.ts', declaredIn: 'memory.yml' };
    const error = await failure(loadBrowserEntries([entry], () => Promise.resolve({ name: 'x' })));
    expect(error instanceof BrowserBuildError ? [error.code, error.entryId] : []).toEqual([
      'browser.not-a-plugin',
      'odd',
    ]);
  });
});

describe('the bundled composition', () => {
  test('reads the prompts by id', async () => {
    const prompts = await readPrompts(PROMPTS);
    expect(Object.keys(prompts)).toContain('system');
    expect(prompts['system']?.length).toBeGreaterThan(0);
  });

  test('loads the shipped composition with its plugins and prompts', async () => {
    const composition = await loadBrowserComposition(BROWSER_YML, PROMPTS);
    expect(composition.entries.length).toBe(17);
    expect(composition.entries.every((entry) => typeof entry.plugin.apply === 'function')).toBe(
      true,
    );
    expect(Object.keys(composition.prompts).length).toBeGreaterThan(3);
  });

  test('is written as a module of static imports', () => {
    const source = compositionModuleSource(
      [
        { id: 'a', name: './a.ts', module: '/src/a.ts', declaredIn: '/c.yml' },
        { id: 'b', name: 'pkg', module: 'pkg', declaredIn: '/c.yml', config: { n: 1 } },
      ],
      { system: 'Be "kind".' },
    );
    expect(source).toBe(
      [
        'import * as plugin0 from "/src/a.ts";',
        'import * as plugin1 from "pkg";',
        'export const composition = {',
        '  entries: [',
        '    { id: "a", name: "./a.ts", plugin: plugin0 },',
        '    { id: "b", name: "pkg", plugin: plugin1, config: {"n":1} },',
        '  ],',
        '  prompts: {"system":"Be \\"kind\\"."},',
        '};',
        '',
      ].join('\n'),
    );
  });
});
