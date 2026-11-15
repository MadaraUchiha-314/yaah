/**
 * The only module that touches cordis' loader packages. It turns a root `cordis.yaml`
 * into a running `Context`, applies an operator's overrides, and fails loudly when any
 * entry of the composition did not come up.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import fs from '@cordisjs/fs';
import nodeFs from '@cordisjs/fs-node';
import type { Entry, EntryOptions, EntryTree } from '@cordisjs/loader';
import loaderPlugin from '@cordisjs/loader';
import { Context } from 'cordis';
import { parse as parseYaml } from 'yaml';

import { PluginLoadError } from './errors.ts';
import type { Json } from './json.ts';
import { EntityRegistry } from './registry.ts';

/** The module name of cordis' include plugin, as it appears in a composition. */
export const INCLUDE = '@cordisjs/include';

/**
 * An operator's change to one entry of the composition, addressed by the entry's `id`.
 *
 * - `config` alone replaces the entry's configuration.
 * - `name` replaces the plugin itself: the default entry is disabled and the named module
 *   is loaded in its place.
 * - `disabled` switches the entry off.
 */
export interface EntryOverride {
  readonly id: string;
  readonly name?: string | undefined;
  readonly config?: Json | undefined;
  readonly disabled?: boolean | undefined;
}

/** What {@link bootstrap} needs. */
export interface BootstrapOptions {
  /** Path of the root `cordis.yaml`. */
  readonly root: string;
  /** Changes to apply on top of the files, by entry id. */
  readonly overrides?: readonly EntryOverride[];
  /** Services provided on the root context before any plugin loads, by name. */
  readonly services?: Readonly<Record<string, unknown>>;
}

/** A running composition. */
export interface Harness {
  /** The root cordis context; services such as `ctx.entities` hang off it. */
  readonly ctx: Context;
  /** Stops every plugin, in reverse, and releases what each registered. */
  dispose(): Promise<void>;
}

interface FileEntry {
  readonly id?: string;
  readonly name?: string;
  readonly config?: { readonly path?: string };
}

/** One `@cordisjs/include` patch. Kept as plain JSON because it travels inside a config. */
type Patch = Record<string, Json>;

interface IncludeConfig {
  path: string;
  patches?: Patch[];
}

function isFileEntryList(value: unknown): value is readonly FileEntry[] {
  return Array.isArray(value);
}

async function readEntries(file: string): Promise<readonly FileEntry[]> {
  const parsed: unknown = parseYaml(await readFile(file, 'utf8'));
  return isFileEntryList(parsed) ? parsed : [];
}

/** The patches that realise one override on the entry it targets. */
function patchFor(override: EntryOverride): Patch[] {
  if (override.name !== undefined) {
    const inserted: Patch = { id: `${override.id}-override`, name: override.name };
    if (override.config !== undefined) {
      inserted['config'] = override.config;
    }
    return [{ id: override.id, disabled: true }, { insert: [inserted] }];
  }
  const patch: Patch = { id: override.id };
  if (override.config !== undefined) {
    patch['config'] = override.config;
  }
  if (override.disabled !== undefined) {
    patch['disabled'] = override.disabled;
  }
  return [patch];
}

/**
 * Builds the include configuration for `file`, carrying each override to the file that
 * declares its entry. cordis' include applies patches to one file only, so an override
 * for an entry of a nested file is expressed as a patch on the nested include entry.
 */
async function planInclude(
  file: string,
  overrides: readonly EntryOverride[],
): Promise<IncludeConfig> {
  const entries = await readEntries(file);
  const patches: Patch[] = [];
  const direct = new Set(entries.map((entry: FileEntry) => entry.id));
  for (const override of overrides) {
    if (direct.has(override.id)) {
      patches.push(...patchFor(override));
    }
  }
  const remaining = overrides.filter((override: EntryOverride) => !direct.has(override.id));
  for (const entry of entries) {
    const nested = entry.config?.path;
    if (entry.name === INCLUDE && entry.id !== undefined && nested !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- files are few and order must be stable
      const plan = await planInclude(resolvePath(dirname(file), nested), remaining);
      if (plan.patches !== undefined) {
        patches.push({ id: entry.id, config: { path: nested, patches: plan.patches } });
      }
    }
  }
  return patches.length === 0 ? { path: file } : { path: file, patches };
}

function* walk(tree: EntryTree): Generator<Entry> {
  for (const entry of tree.entries()) {
    yield entry;
  }
}

function shortId(entry: Entry): string {
  return entry.id.split(':').at(-1) ?? entry.id;
}

/** Throws for the first entry of the composition that is not running. */
async function assertAllLoaded(tree: EntryTree): Promise<void> {
  for (const entry of walk(tree)) {
    // `entry.disabled` is also true for an entry cordis gave up on, so read the option.
    if (entry.options.disabled === true) {
      continue;
    }
    const fiber = entry.innerFiber;
    if (fiber === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- the first failure ends the loop
      const cause = await importFailure(entry);
      throw new PluginLoadError(shortId(entry), entry.options.name, cause);
    }
    // A fiber that threw while starting rejects here; a running one resolves at once.
    // oxlint-disable-next-line no-await-in-loop -- the first failure ends the loop
    const cause = await fiberFailure(fiber);
    if (cause !== undefined) {
      throw new PluginLoadError(shortId(entry), entry.options.name, cause);
    }
  }
}

async function importFailure(entry: Entry): Promise<unknown> {
  try {
    await entry.parent.tree.import(entry.options.name);
  } catch (error) {
    return error;
  }
  return undefined;
}

async function fiberFailure(fiber: { await(): Promise<unknown> }): Promise<unknown> {
  try {
    await fiber.await();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Starts a harness from a root composition file.
 *
 * @throws PluginLoadError when an entry's module cannot be imported or throws while
 *   starting. Nothing is left running in that case.
 */
export async function bootstrap(options: BootstrapOptions): Promise<Harness> {
  const root = resolvePath(options.root);
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(`${dirname(root)}/`).href;
  ctx.provide('entities', new EntityRegistry());
  for (const [name, value] of Object.entries(options.services ?? {})) {
    ctx.provide(name, value);
  }
  await ctx.use(fs);
  await ctx.use(nodeFs);
  await ctx.use(loaderPlugin);
  const dispose = async (): Promise<void> => {
    await ctx.fiber.dispose();
  };
  try {
    const config = await planInclude(root, options.overrides ?? []);
    const entry: Omit<EntryOptions, 'id'> = { name: INCLUDE, config };
    await ctx.loader.create(entry);
    await ctx.loader.await();
    await assertAllLoaded(ctx.loader);
  } catch (error) {
    await dispose();
    throw error;
  }
  return { ctx, dispose };
}
