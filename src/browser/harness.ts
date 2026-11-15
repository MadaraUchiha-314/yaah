/**
 * The browser build's counterpart of `createHarness`. cordis' file loader needs a file
 * system, so the composition arrives already resolved — a static list of plugin modules
 * that `bun run build:browser` produced from `browser.yml` — and is walked with `ctx.use`.
 */
import type { Fiber } from 'cordis';
import { Context } from 'cordis';

import type { EntryOverride, Harness } from '../kernel/bootstrap.ts';
import type { YaahConfig } from '../kernel/config-types.ts';
import { defaultConfig } from '../kernel/config.ts';
import type { Credentials } from '../kernel/credentials.ts';
import { PluginLoadError, YaahError } from '../kernel/errors.ts';
import type { CreateHarnessOptions } from '../kernel/harness.ts';
import type { Json } from '../kernel/json.ts';
import { Redactor } from '../kernel/redactor.ts';
import { EntityRegistry } from '../kernel/registry.ts';
import { SHIPPED_TABLES, Strings, t } from '../kernel/strings.ts';

/**
 * A plugin module as a composition names one: `name`, `inject` and `apply`. `apply` is a
 * method so that a module whose configuration has a type of its own fits.
 */
export interface BrowserPlugin {
  readonly name?: string;
  readonly inject?: readonly string[];
  apply(ctx: Context, config: unknown): unknown;
}

/** One entry of a resolved composition. */
export interface BrowserEntry {
  /** The entry's id in the composition; an override addresses it by this. */
  readonly id: string;
  /** The module the composition names, for error messages. */
  readonly name: string;
  /** The module itself, imported statically by the build. */
  readonly plugin: BrowserPlugin;
  readonly config?: Json | undefined;
}

/** A composition resolved at build time, and the files the code would read from disk. */
export interface BrowserComposition {
  readonly entries: readonly BrowserEntry[];
  /** The shipped prompts: markdown source by prompt id. */
  readonly prompts: Readonly<Record<string, string>>;
}

declare module 'cordis' {
  interface Context {
    /** The prompts bundled into this build: markdown source by prompt id. */
    promptSources: Readonly<Record<string, string>>;
  }
}

/** What {@link createBrowserHarness} accepts. */
export interface CreateBrowserHarnessOptions {
  /** The resolved composition — in the shipped build, the list made from `browser.yml`. */
  readonly composition: BrowserComposition;
  /** The configuration. Defaults to the default configuration with in-memory stores. */
  readonly config?: YaahConfig;
  /**
   * Secrets by the name the configuration gives them (`api_key_env`), standing in for the
   * environment a tab does not have.
   *
   * Security: whatever is passed here is in the page's memory and in the requests the
   * page makes, so the person using the browser can read it. Pass a key only when that
   * person owns it; otherwise configure an endpoint that needs none — a proxy of your
   * own that adds the key on a server.
   */
  readonly credentials?: Credentials;
  /** Runs once the composition is up, with the root context, as in `createHarness`. */
  readonly setup?: CreateHarnessOptions['setup'];
}

/** The state of a cordis fiber whose plugin is running (`FiberState.ACTIVE`). */
const ACTIVE = 2;

/** `data_dir` value that selects the in-memory stores, the only ones a tab has. */
const MEMORY = ':memory:';

/**
 * Applies the operator's overrides by entry id. A tab cannot import a module by name, so
 * an override may reconfigure or disable an entry but not replace its plugin.
 *
 * @throws YaahError `browser.override-name` for an override that names a module.
 */
function withOverrides(
  entries: readonly BrowserEntry[],
  overrides: readonly EntryOverride[],
): BrowserEntry[] {
  const byId = new Map(overrides.map((override: EntryOverride) => [override.id, override]));
  const kept: BrowserEntry[] = [];
  for (const entry of entries) {
    const override = byId.get(entry.id);
    if (override?.name !== undefined) {
      throw new YaahError(
        'browser.override-name',
        t('error.browser.override-name', { entryId: entry.id, name: override.name }),
      );
    }
    if (override?.disabled !== true) {
      kept.push(override?.config === undefined ? entry : { ...entry, config: override.config });
    }
  }
  return kept;
}

/** The services a started entry is still waiting for, by name. */
function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter((service: string) => ctx.get(service) === undefined);
}

/**
 * Starts every entry in order.
 *
 * @throws PluginLoadError naming the first entry that threw while starting, or that is
 *   still waiting for a service nothing in the composition provides.
 */
async function startEntries(ctx: Context, entries: readonly BrowserEntry[]): Promise<void> {
  const started: [BrowserEntry, Fiber][] = [];
  for (const entry of entries) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- entries start in composition order
      started.push([entry, await ctx.use(entry.plugin, entry.config)]);
    } catch (error) {
      throw new PluginLoadError(entry.id, entry.name, error);
    }
  }
  for (const [entry, fiber] of started) {
    const state: number = fiber.state;
    if (state !== ACTIVE) {
      const services = missingServices(ctx, fiber).join(', ');
      throw new PluginLoadError(
        entry.id,
        entry.name,
        new Error(t('error.browser.waiting', { services })),
      );
    }
  }
}

/**
 * Builds a running harness from a resolved composition, with no file system, no listener
 * and no process environment. Surfaces reach it through `ctx.harnessTarget`.
 *
 * @throws PluginLoadError when a plugin of the composition does not come up. Nothing is
 *   left running in that case.
 * @throws YaahError `browser.override-name` when the configuration replaces a plugin.
 */
export async function createBrowserHarness(options: CreateBrowserHarnessOptions): Promise<Harness> {
  const config = options.config ?? { ...defaultConfig(), dataDir: MEMORY };
  const entries = withOverrides(options.composition.entries, config.overrides);
  const credentials = options.credentials ?? {};
  const redactor = new Redactor();
  for (const secret of Object.values(credentials)) {
    redactor.add(secret);
  }
  const ctx = new Context();
  ctx.provide('entities', new EntityRegistry());
  ctx.provide('config', config);
  ctx.provide('strings', new Strings(SHIPPED_TABLES, config.locale));
  ctx.provide('redactor', redactor);
  ctx.provide('credentials', credentials);
  ctx.provide('promptSources', options.composition.prompts);
  const dispose = async (): Promise<void> => {
    await ctx.fiber.dispose();
  };
  try {
    await startEntries(ctx, entries);
    await options.setup?.(ctx);
    await ctx.parallel('harness/ready');
  } catch (error) {
    await dispose();
    throw error;
  }
  return { ctx, dispose };
}
