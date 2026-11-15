/**
 * How the shipped page starts its harness: where the configuration and the credentials
 * come from when there is no file system and no environment.
 *
 * - The configuration is `config.toml`, the same file every other build reads, fetched
 *   from beside the page — a static asset of the site.
 * - A page that embeds the build may set `globalThis.yaah = { config, credentials }`
 *   before the application script runs: `config` is TOML text used instead of the file,
 *   `credentials` are secrets by the name the configuration gives them (`api_key_env`).
 *
 * Security: a credential given to a page can be read by whoever uses the browser. The
 * file never holds one, and the default is to need none — an OpenAI-compatible `base_url`
 * that points at a proxy of your own, which adds the key on a server.
 */
import type { Harness } from '../kernel/bootstrap.ts';
import type { YaahConfig } from '../kernel/config-types.ts';
import { parseConfig } from '../kernel/config.ts';
import type { Credentials } from '../kernel/credentials.ts';
import { YaahError } from '../kernel/errors.ts';
import { t } from '../kernel/strings.ts';
import type { BrowserComposition } from './harness.ts';
import { createBrowserHarness } from './harness.ts';

/** The configuration file, beside the page. */
export const CONFIG_FILE = 'config.toml';

/** What an embedding page may set as `globalThis.yaah`. */
export interface PageOptions {
  /** TOML text, used instead of fetching {@link CONFIG_FILE}. */
  readonly config?: string;
  readonly credentials?: Credentials;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Reads `scope.yaah`, keeping only what has the right type. */
export function pageOptions(scope: object = globalThis): PageOptions {
  const given: unknown = Reflect.get(scope, 'yaah');
  if (!isRecord(given)) {
    return {};
  }
  const { config, credentials } = given;
  const secrets = Object.entries(isRecord(credentials) ? credentials : {}).filter(
    (entry: [string, unknown]): entry is [string, string] => typeof entry[1] === 'string',
  );
  return {
    ...(typeof config === 'string' ? { config } : {}),
    ...(secrets.length === 0 ? {} : { credentials: Object.fromEntries(secrets) }),
  };
}

/**
 * Fetches the configuration file from beside the page. A site that ships none runs on
 * the defaults.
 *
 * @throws YaahError `browser.config` when the file exists and cannot be read.
 */
async function fetchConfig(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(CONFIG_FILE);
  if (response.status === 404) {
    return '';
  }
  if (!response.ok) {
    const reason = `${String(response.status)} ${response.statusText}`.trim();
    throw new YaahError('browser.config', t('browser.error.config', { file: CONFIG_FILE, reason }));
  }
  return response.text();
}

/**
 * Starts the page's harness: the configuration parsed as every build parses it, with the
 * in-memory stores a tab is limited to.
 *
 * @throws ConfigError when the configuration is not valid.
 * @throws PluginLoadError when a plugin does not come up — for example a provider whose
 *   key was not given.
 */
export async function startPageHarness(
  composition: BrowserComposition,
  options: PageOptions = pageOptions(),
  fetcher: typeof fetch = fetch,
): Promise<Harness> {
  const source = options.config ?? (await fetchConfig(fetcher));
  const config: YaahConfig = { ...parseConfig(source, CONFIG_FILE), dataDir: ':memory:' };
  return createBrowserHarness({
    composition,
    config,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}
