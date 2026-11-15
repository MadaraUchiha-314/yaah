import type { EntityRef } from './entity.ts';
import { t } from './strings.ts';
import { YaahError } from './yaah-error.ts';

export { YaahError } from './yaah-error.ts';

function refParams(ref: EntityRef): Record<string, string> {
  return { kind: ref.kind, id: ref.id, version: ref.version ?? 'null' };
}

/** No entity is registered under the requested `(kind, id, version)`. */
export class EntityNotFoundError extends YaahError {
  readonly ref: EntityRef;

  constructor(ref: EntityRef) {
    super('entity.not-found', t('error.entity.not-found', refParams(ref)));
    this.ref = ref;
  }
}

/** An entity is already registered under that address and no override was declared. */
export class EntityConflictError extends YaahError {
  readonly ref: EntityRef;

  constructor(ref: EntityRef) {
    super('entity.conflict', t('error.entity.conflict', refParams(ref)));
    this.ref = ref;
  }
}

/** A plugin named in the composition could not be imported, or threw while starting. */
export class PluginLoadError extends YaahError {
  /** The composition entry's id. */
  readonly entryId: string;
  /** The module the entry names. */
  readonly pluginName: string;

  constructor(entryId: string, pluginName: string, cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : t('error.plugin.missing');
    super('plugin.load', t('error.plugin.load', { entryId, name: pluginName, reason }), cause);
    this.entryId = entryId;
    this.pluginName = pluginName;
  }
}

/** The configuration file could not be read, parsed or validated. */
export class ConfigError extends YaahError {
  /** The file at fault. */
  readonly file: string;
  /** The dotted key at fault, when the failure is about one key. */
  readonly key: string | null;

  constructor(code: string, message: string, file: string, key: string | null, cause?: unknown) {
    super(code, message, cause);
    this.file = file;
    this.key = key;
  }
}

/** A prompt was rendered without a value for one of its declared variables. */
export class PromptVariableError extends YaahError {
  readonly variable: string;

  constructor(promptId: string, variable: string) {
    super('prompt.variable', t('error.prompt.variable', { id: promptId, variable }));
    this.variable = variable;
  }
}
