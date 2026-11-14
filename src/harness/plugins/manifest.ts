/**
 * `plugin.json` of an agent plugin, checked against the Agent Plugins specification
 * 1.0.0 (§5 and §8.1) with the specification's own JSON Schema, vendored under
 * `specs/vendor/agent-plugins/`. No schema is ever fetched.
 */
import { readFile } from 'node:fs/promises';

import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';

import { assetPath } from '../../kernel/assets.ts';
import type { JsonObject } from '../../kernel/json.ts';
import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';

/** The specification version this loader implements. */
export const AGENT_PLUGINS_VERSION = '1.0.0';
/** The `$schema` a `plugin.json` of that version must carry. */
export const PLUGIN_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** The `$schema` an `mcp.json` of that version must carry. */
export const MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** An agent plugin was refused. `rule` names the rule it broke, with its section. */
export class AgentPluginError extends YaahError {
  readonly rule: string;

  constructor(plugin: string, rule: string, detail: string) {
    super('plugin.invalid', t('plugin.error.invalid', { plugin, rule, detail }));
    this.rule = rule;
  }
}

/** The two vendored schemas. */
export interface PluginSchemas {
  readonly plugin: JsonObject;
  readonly mcp: JsonObject;
}

const jsonObject = z.record(z.string(), z.json());

/** Reads the vendored schemas from the package. */
export async function readPluginSchemas(): Promise<PluginSchemas> {
  const read = async (file: string): Promise<JsonObject> => {
    const path = assetPath('..', 'specs', 'vendor', 'agent-plugins', AGENT_PLUGINS_VERSION, file);
    return jsonObject.parse(JSON.parse(await readFile(path, 'utf8')));
  };
  const [plugin, mcp] = await Promise.all([read('plugin.schema.json'), read('mcp.schema.json')]);
  return { plugin, mcp };
}

/** What yaah reads from a valid manifest. */
export interface PluginManifest {
  readonly name: string;
  readonly version: string | undefined;
  readonly description: string | undefined;
}

/** A valid manifest and what was reported and ignored on the way. */
export interface ManifestOutcome {
  readonly manifest: PluginManifest;
  readonly notices: readonly string[];
}

/** The section of the specification a manifest field is ruled by. */
function sectionOf(field: string): string {
  if (field === 'name') {
    return '§5.5';
  }
  if (field === 'extensions') {
    return '§8.1';
  }
  return field === '' || field === '$schema' ? '§5.3' : '§5.4';
}

/**
 * Names the rule a schema failure broke, from the validator's most specific error: the
 * section, the field and the schema keyword — `§5.5 name: pattern`.
 */
export function ruleOf(
  errors: readonly { keyword: string; instanceLocation: string; error: string }[],
): { rule: string; detail: string } {
  const last = errors.at(-1);
  const path = (last?.instanceLocation ?? '#').replace(/^#\/?/u, '');
  const [field = ''] = path.split('/');
  const where = path === '' ? '' : ` ${path}:`;
  return {
    rule: `${sectionOf(field)}${where} ${last?.keyword ?? 'schema'}`,
    detail: last?.error ?? '',
  };
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Checks a parsed `plugin.json`.
 *
 * Per §5.2 and §8.1 two violations are reported and ignored — an unknown top-level field
 * and an `extensions` that is not an object. Everything else is fatal: a manifest that is
 * not an object, a missing or unrecognised `$schema` (only 1.0.0 is supported), a `name`
 * outside §5.5, a metadata field of the wrong type, an `author` with other fields, an
 * extension entry that is not an object.
 *
 * @param label how the plugin is called in the error — its path, before its name is known.
 * @throws AgentPluginError naming the rule.
 */
export function validateManifest(raw: unknown, schema: JsonObject, label: string): ManifestOutcome {
  if (!isObject(raw)) {
    throw new AgentPluginError(label, '§5.2 manifest: type', t('plugin.rule.manifest-object'));
  }
  const source: Readonly<Record<string, unknown>> = { ...raw };
  const declared = source['$schema'];
  if (typeof declared === 'string' && declared !== PLUGIN_SCHEMA_ID) {
    const detail = t('plugin.rule.unsupported-version', { schema: declared });
    throw new AgentPluginError(label, '§5.2 $schema: unsupported version', detail);
  }
  const notices: string[] = [];
  const known = new Set(Object.keys(jsonObject.parse(schema['properties'] ?? {})));
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(source)) {
    if (!known.has(field)) {
      notices.push(t('plugin.notice.unknown-field', { field }));
    } else if (field === 'extensions' && !isObject(value)) {
      notices.push(t('plugin.notice.extensions'));
    } else {
      fields[field] = value;
    }
  }
  const outcome = new Validator(schema, '2020-12', false).validate(fields);
  if (!outcome.valid) {
    const { rule, detail } = ruleOf(outcome.errors);
    throw new AgentPluginError(label, rule, detail);
  }
  return {
    manifest: {
      name: optional(fields['name']) ?? '',
      version: optional(fields['version']),
      description: optional(fields['description']),
    },
    notices,
  };
}
