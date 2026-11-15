/**
 * Build-time resolution of a browser composition. cordis' loader reads YAML through a
 * file system a tab does not have, so `bun run build:browser` reads the composition here,
 * on Node or Bun, and turns it into a static list of plugin modules. This is also where a
 * plugin that cannot run in a browser is refused, by name.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { INCLUDE } from '../../kernel/bootstrap.ts';
import { YaahError } from '../../kernel/errors.ts';
import type { Json } from '../../kernel/json.ts';
import { t } from '../../kernel/strings.ts';
import type { BrowserComposition, BrowserEntry, BrowserPlugin } from '../harness.ts';

/** The runtime a plugin must list in its `runtime` export to be part of a browser build. */
export const BROWSER_RUNTIME = 'browser';

/** One plugin entry of a composition, with its includes followed. */
export interface ResolvedEntry {
  readonly id: string;
  /** The module as the composition names it. */
  readonly name: string;
  /** What to import: an absolute path for a relative name, else the name itself. */
  readonly module: string;
  /** The composition file that declares the entry. */
  readonly declaredIn: string;
  readonly config?: Json | undefined;
}

/** A composition cannot be built for the browser because of one of its entries. */
export class BrowserBuildError extends YaahError {
  /** The id of the entry at fault. */
  readonly entryId: string;
  /** The module that entry names. */
  readonly module: string;

  constructor(code: string, message: string, entry: { id: string; name: string }) {
    super(code, message);
    this.entryId = entry.id;
    this.module = entry.name;
  }
}

const entrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  config: z.json().optional(),
  disabled: z.boolean().optional(),
});

const includeSchema = z.object({ path: z.string().min(1), patches: z.unknown().optional() });

type FileEntry = z.infer<typeof entrySchema>;

async function readEntries(file: string): Promise<FileEntry[]> {
  const parsed = z.array(entrySchema).safeParse(parseYaml(await readFile(file, 'utf8')));
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? '';
    throw new YaahError('browser.composition', t('error.browser.composition', { file, reason }));
  }
  return parsed.data;
}

function isRelative(name: string): boolean {
  return name.startsWith('./') || name.startsWith('../');
}

/** The file an include entry names. Patches are a loader feature this resolver lacks. */
function includedFile(entry: FileEntry, file: string): string {
  const include = includeSchema.safeParse(entry.config);
  if (!include.success || include.data.patches !== undefined) {
    throw new BrowserBuildError(
      'browser.include',
      t('error.browser.include', { entryId: entry.id, file }),
      entry,
    );
  }
  return resolvePath(dirname(file), include.data.path);
}

/**
 * Reads the composition at `root` and every file it includes, in order, into one flat
 * list of plugin entries. A disabled entry is left out.
 *
 * @throws YaahError `browser.composition` for a file that is not a list of entries.
 * @throws BrowserBuildError `browser.include` for an include with no path or with patches.
 */
export async function resolveBrowserComposition(root: string): Promise<ResolvedEntry[]> {
  const file = resolvePath(root);
  const resolved: ResolvedEntry[] = [];
  for (const entry of await readEntries(file)) {
    if (entry.disabled === true) {
      continue;
    }
    if (entry.name === INCLUDE) {
      // oxlint-disable-next-line no-await-in-loop -- files are few and order must be stable
      resolved.push(...(await resolveBrowserComposition(includedFile(entry, file))));
    } else {
      resolved.push({
        id: entry.id,
        name: entry.name,
        module: isRelative(entry.name) ? resolvePath(dirname(file), entry.name) : entry.name,
        declaredIn: file,
        config: entry.config,
      });
    }
  }
  return resolved;
}

/** Imports the module an entry names. */
export type LoadModule = (entry: ResolvedEntry) => Promise<unknown>;

const importModule: LoadModule = (entry: ResolvedEntry): Promise<unknown> =>
  import(isRelative(entry.name) ? pathToFileURL(entry.module).href : entry.module);

const pluginSchema = z.object({
  apply: z.custom<BrowserPlugin['apply']>((value: unknown) => typeof value === 'function'),
  name: z.string().optional(),
  inject: z.array(z.string()).readonly().optional(),
  runtime: z.array(z.string()).readonly().optional(),
});

/**
 * Imports every entry's module and returns the plugins, refusing a module that says it
 * cannot run in a browser. A plugin says so by exporting the runtimes it needs:
 * `export const runtime: readonly string[] = ['node']`. A plugin that exports no
 * `runtime` claims to run anywhere.
 *
 * @throws BrowserBuildError `browser.node-only` naming the first entry whose plugin does
 *   not list the browser, and `browser.not-a-plugin` for a module without `apply`.
 */
export async function loadBrowserEntries(
  entries: readonly ResolvedEntry[],
  load: LoadModule = importModule,
): Promise<BrowserEntry[]> {
  const loaded: BrowserEntry[] = [];
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- the first entry at fault ends the loop
    const plugin = pluginSchema.safeParse(await load(entry));
    if (!plugin.success) {
      const message = t('error.browser.not-a-plugin', { entryId: entry.id, module: entry.name });
      throw new BrowserBuildError('browser.not-a-plugin', message, entry);
    }
    const { runtime, ...module } = plugin.data;
    if (runtime !== undefined && !runtime.includes(BROWSER_RUNTIME)) {
      const params = { entryId: entry.id, module: entry.name, runtime: runtime.join(', ') };
      throw new BrowserBuildError('browser.node-only', t('error.browser.node-only', params), entry);
    }
    loaded.push({
      id: entry.id,
      name: entry.name,
      plugin: {
        apply: module.apply,
        ...(module.name === undefined ? {} : { name: module.name }),
        ...(module.inject === undefined ? {} : { inject: module.inject }),
      },
      config: entry.config,
    });
  }
  return loaded;
}

/** Reads a directory of markdown prompts into source by prompt id (the file's base name). */
export async function readPrompts(dir: string): Promise<Record<string, string>> {
  const files = (await readdir(dir)).filter((file: string) => extname(file) === '.md').toSorted();
  const sources = await Promise.all(files.map((file: string) => readFile(join(dir, file), 'utf8')));
  return Object.fromEntries(
    files.map((file: string, index: number) => [basename(file, '.md'), sources[index] ?? '']),
  );
}

/**
 * Resolves, checks and imports a browser composition in this process — what the build
 * does ahead of time, done at once. For tests, and for running the browser composition
 * on Node or Bun.
 *
 * @throws BrowserBuildError as {@link loadBrowserEntries} does.
 */
export async function loadBrowserComposition(
  root: string,
  promptsDir: string,
): Promise<BrowserComposition> {
  const entries = await loadBrowserEntries(await resolveBrowserComposition(root));
  return { entries, prompts: await readPrompts(promptsDir) };
}

/**
 * The source of the module the build bundles in place of the composition file: a static
 * import of every plugin and the list that {@link BrowserComposition} describes.
 */
export function compositionModuleSource(
  entries: readonly ResolvedEntry[],
  prompts: Readonly<Record<string, string>>,
): string {
  const imports = entries.map(
    (entry: ResolvedEntry, index: number) =>
      `import * as plugin${String(index)} from ${JSON.stringify(entry.module)};`,
  );
  const list = entries.map((entry: ResolvedEntry, index: number) => {
    const fields = [
      `id: ${JSON.stringify(entry.id)}`,
      `name: ${JSON.stringify(entry.name)}`,
      `plugin: plugin${String(index)}`,
      ...(entry.config === undefined ? [] : [`config: ${JSON.stringify(entry.config)}`]),
    ];
    return `    { ${fields.join(', ')} },`;
  });
  return [
    ...imports,
    'export const composition = {',
    '  entries: [',
    ...list,
    '  ],',
    `  prompts: ${JSON.stringify(prompts)},`,
    '};',
    '',
  ].join('\n');
}
