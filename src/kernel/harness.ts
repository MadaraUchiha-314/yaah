import { isAbsolute, resolve as resolvePath } from 'node:path';

import { assetPath, hasAsset } from './assets.ts';
import type { Harness } from './bootstrap.ts';
import { bootstrap } from './bootstrap.ts';
import type { YaahConfig } from './config-types.ts';
import { defaultConfig } from './config.ts';
import { YaahError } from './errors.ts';
import { Redactor } from './redactor.ts';
import { SHIPPED_TABLES, Strings, t } from './strings.ts';

declare module 'cordis' {
  interface Context {
    /** The validated configuration this harness was started with. */
    config: YaahConfig;
    /** User-visible strings in the configured locale. */
    strings: Strings;
    /** Removes credentials from anything leaving the process. */
    redactor: Redactor;
  }
}

/** What {@link createHarness} accepts. */
export interface CreateHarnessOptions {
  /** The configuration. Defaults to {@link defaultConfig}. */
  readonly config?: YaahConfig;
  /** Directory a relative `config.composition` path is resolved against. */
  readonly cwd?: string;
}

/**
 * The file a `composition` setting names: a shipped build (`"cli"`, `"server"`) or a path
 * to a root `cordis.yaml`.
 *
 * @throws YaahError `composition.unknown` for a bare name that is not a shipped build.
 */
export function resolveComposition(composition: string, cwd: string = process.cwd()): string {
  const looksLikePath = /[/\\]|\.ya?ml$/u.test(composition);
  if (looksLikePath) {
    return isAbsolute(composition) ? composition : resolvePath(cwd, composition);
  }
  if (!hasAsset('compositions', `${composition}.yml`)) {
    throw new YaahError(
      'composition.unknown',
      t('error.composition.unknown', { name: composition }),
    );
  }
  return assetPath('compositions', `${composition}.yml`);
}

/**
 * Builds a running harness from a configuration — the one entry point the CLI and an
 * embedding application share.
 *
 * @throws PluginLoadError when a plugin of the composition does not come up.
 */
export async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
  const config = options.config ?? defaultConfig();
  const harness = await bootstrap({
    root: resolveComposition(config.composition, options.cwd),
    overrides: config.overrides,
    services: {
      config,
      strings: new Strings(SHIPPED_TABLES, config.locale),
      redactor: new Redactor(),
    },
  });
  return harness;
}
