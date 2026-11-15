/**
 * The operator's configuration file, `~/.yaah/config.toml`.
 *
 * The file is TOML with snake_case keys; code reads the camelCase {@link YaahConfig}.
 * Every key has a default, an unknown key is an error, and no key ever holds a secret —
 * credentials are named by environment variable (`api_key_env`).
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { DEFAULT_CONFIG_TOML } from './config-default.ts';
import { validateConfig } from './config-schema.ts';
import type { YaahConfig } from './config-types.ts';
import { ConfigError } from './errors.ts';
import { t } from './strings.ts';

export { DEFAULT_CONFIG_TOML } from './config-default.ts';
export { configJsonSchema } from './config-schema.ts';
export type * from './config-types.ts';

/**
 * Validates TOML source against the schema.
 *
 * @param file The file name, used only in error messages.
 * @throws ConfigError `config.parse` for invalid TOML; `config.invalid` for an unknown
 *   key or a wrong value, with `key` set to the dotted path at fault.
 */
export function parseConfig(source: string, file: string): YaahConfig {
  let raw: unknown = {};
  try {
    raw = parseToml(source);
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    throw new ConfigError('config.parse', t('error.config.parse', { file, reason }), file, null);
  }
  const result = validateConfig(raw);
  if (!result.ok) {
    const { key, reason } = result.issue;
    throw new ConfigError(
      'config.invalid',
      t('error.config.invalid', { file, key, reason }),
      file,
      key,
    );
  }
  return result.config;
}

/** The configuration when the file sets nothing. */
export function defaultConfig(): YaahConfig {
  return parseConfig('', 'defaults');
}

/** Where {@link loadConfig} looks. */
export interface LoadConfigOptions {
  /** `--config <path>`: use this file and nothing else. */
  readonly path?: string | undefined;
  /** The user's home directory. Defaults to the real one; tests pass a temporary one. */
  readonly home?: string | undefined;
}

/** A loaded configuration and where it came from. */
export interface LoadedConfig {
  readonly config: YaahConfig;
  readonly file: string;
  /** True when the default file did not exist and was just written. */
  readonly created: boolean;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readConfigFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError('config.read', t('error.config.read', { file, reason }), file, null);
  }
}

/**
 * Loads the configuration.
 *
 * Priority: `options.path` when given; otherwise `~/.yaah/config.toml`, which is created
 * with the defaults (mode `0600`) if it does not exist. An explicit path is never created.
 *
 * @throws ConfigError when the file cannot be read, is not TOML, or fails validation.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  if (options.path !== undefined) {
    const source = await readConfigFile(options.path);
    if (source === null) {
      const reason = t('error.config.missing');
      throw new ConfigError(
        'config.read',
        t('error.config.read', { file: options.path, reason }),
        options.path,
        null,
      );
    }
    return { config: parseConfig(source, options.path), file: options.path, created: false };
  }
  const file = join(options.home ?? homedir(), '.yaah', 'config.toml');
  const existing = await readConfigFile(file);
  if (existing !== null) {
    return { config: parseConfig(existing, file), file, created: false };
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, DEFAULT_CONFIG_TOML, { mode: 0o600 });
  await chmod(file, 0o600);
  return { config: parseConfig(DEFAULT_CONFIG_TOML, file), file, created: true };
}
