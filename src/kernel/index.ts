/**
 * The kernel: what every other part of yaah is built on — the entity model and registry,
 * the composition bootstrap, configuration, strings, errors and the redactor.
 */
export { assetPath } from './assets.ts';
export { bootstrap, INCLUDE } from './bootstrap.ts';
export type { BootstrapOptions, EntryOverride, Harness } from './bootstrap.ts';
export {
  configJsonSchema,
  DEFAULT_CONFIG_TOML,
  defaultConfig,
  loadConfig,
  parseConfig,
} from './config.ts';
export type { LoadConfigOptions, LoadedConfig } from './config.ts';
export type * from './config-types.ts';
export { formatRef, LOCAL } from './entity.ts';
export type {
  AnyEntity,
  Entity,
  EntityKind,
  EntityMap,
  EntityOf,
  EntityRef,
  Locality,
} from './entity.ts';
export {
  ConfigError,
  EntityConflictError,
  EntityNotFoundError,
  PluginLoadError,
  PromptVariableError,
  YaahError,
} from './errors.ts';
export { createHarness, resolveComposition } from './harness.ts';
export type { CreateHarnessOptions } from './harness.ts';
export { isJsonObject } from './json.ts';
export type { Json, JsonArray, JsonObject, JsonPrimitive } from './json.ts';
export { REDACTED, Redactor } from './redactor.ts';
export { EntityRegistry, registerEntity } from './registry.ts';
export type { Disposer, RegisterOptions } from './registry.ts';
export { DEFAULT_LOCALE, SHIPPED_TABLES, Strings, t } from './strings.ts';
export type { StringParams, StringTable } from './strings.ts';
