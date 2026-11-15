/**
 * Builds the browser build (`bun run build:browser`): the harness and the web chat as a
 * static site in `dist/browser/`, with no yaah server behind it.
 *
 * The composition (`src/compositions/browser.yml`, or the file given as the first
 * argument; a second argument names the output directory) is resolved here, at build
 * time, into a static list of plugin modules that the bundle imports. A plugin that
 * cannot run in a browser fails the build, by name: first by its own `runtime`
 * declaration, then by what its code actually imports.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { build } from 'vite';

import { findBuiltinPath, isSchemeBuiltin } from '../src/browser/build/graph.ts';
import type { ResolvedEntry } from '../src/browser/build/resolve.ts';
import {
  BrowserBuildError,
  compositionModuleSource,
  loadBrowserEntries,
  readPrompts,
  resolveBrowserComposition,
} from '../src/browser/build/resolve.ts';
import { t } from '../src/kernel/strings.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'src');
const PAGE = join(SRC, 'browser', 'page');
/** Where the site goes: `dist/browser`, or the directory given as the second argument. */
const OUT_DIR = process.argv[3] ?? join(ROOT, 'dist', 'browser');
/** What a previous run of this script left in `dist/browser`, beside the package's modules. */
const SITE_FILES = ['index.html', 'assets', 'config.toml'];

/** The module the page imports its composition from; the build supplies its content. */
const COMPOSITION = join(PAGE, 'composition.ts');
const NODE_ONLY = '\0yaah-node-only:';

const shown = (id: string): string => (id.startsWith(ROOT) ? relative(ROOT, id) : id);
const isRuntimeBuiltin = (id: string): boolean => isSchemeBuiltin(id) || isBuiltin(id);

/**
 * The Vite plugin of the browser build.
 *
 * - Serves the resolved composition as a module.
 * - Does not follow an `import()` made by yaah's own source: that is how a module keeps a
 *   Node-only branch out of the browser. The import is replaced by one that rejects.
 * - Leaves runtime builtins unresolved, then refuses the build if a plugin of the
 *   composition reaches one through static imports.
 */
function browserBuild(entries: readonly ResolvedEntry[], prompts: Record<string, string>): Plugin {
  return {
    name: 'yaah-browser-build',
    enforce: 'pre',
    resolveId(source, importer, options) {
      if (isRuntimeBuiltin(source)) {
        return { id: source, external: true };
      }
      const own = importer?.startsWith(SRC) === true && options.kind === 'dynamic-import';
      return own ? `${NODE_ONLY}${source}\0${shown(importer)}` : null;
    },
    load(id) {
      if (id === COMPOSITION) {
        return compositionModuleSource(entries, prompts);
      }
      if (id.startsWith(NODE_ONLY)) {
        const [module = '', importer = ''] = id.slice(NODE_ONLY.length).split('\0');
        const message = t('error.browser.node-import', { module, importer });
        return `throw new Error(${JSON.stringify(message)});\nexport {};\n`;
      }
      return null;
    },
    buildEnd(error) {
      if (error !== undefined) {
        return;
      }
      const graph = {
        importsOf: (id: string): readonly string[] => this.getModuleInfo(id)?.importedIds ?? [],
        isBuiltin: isRuntimeBuiltin,
      };
      for (const entry of entries) {
        const resolved = [...this.getModuleIds()].find((id) => id === entry.module);
        const found = resolved === undefined ? null : findBuiltinPath(graph, resolved);
        if (found !== null) {
          const chain = found.chain.map(shown).join(' → ');
          const params = { entryId: entry.id, module: entry.name, builtin: found.builtin, chain };
          this.error(
            new BrowserBuildError('browser.builtin', t('error.browser.builtin', params), entry),
          );
        }
      }
    },
  };
}

async function sizeOf(dir: string): Promise<number> {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith('.js'))
      .map(async (file) => (await stat(join(file.parentPath, file.name))).size),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function main(): Promise<void> {
  const composition = process.argv[2] ?? join(SRC, 'compositions', 'browser.yml');
  const entries = await resolveBrowserComposition(composition);
  // The declared check: importing each plugin here, on Bun, reads its `runtime` export.
  await loadBrowserEntries(entries);
  const prompts = await readPrompts(join(SRC, 'prompts'));
  await Promise.all(
    SITE_FILES.map((file) => rm(join(OUT_DIR, file), { recursive: true, force: true })),
  );
  await build({
    configFile: false,
    root: PAGE,
    base: './',
    logLevel: 'warn',
    plugins: [browserBuild(entries, prompts), react(), tailwindcss()],
    build: {
      outDir: OUT_DIR,
      // dist/browser also holds the package's `@yaah/yaah/browser` modules.
      emptyOutDir: false,
      target: 'es2022',
      chunkSizeWarningLimit: 3000,
    },
  });
  const size = `${((await sizeOf(join(OUT_DIR, 'assets'))) / 1024).toFixed(0)} kB`;
  console.log(t('browser.build.done', { dir: shown(OUT_DIR), count: entries.length, size }));
}

try {
  await main();
} catch (error) {
  // The reason is the message; a stack trace of the build script helps nobody.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
