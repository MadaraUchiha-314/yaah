import { describe, expect, test } from 'bun:test';

import {
  FULL_MANIFEST,
  INVALID_NAMES,
  MINIMAL_MANIFEST,
  VALID_NAMES,
} from '../../../test/fixtures/agent-plugins/spec-examples.ts';
import {
  AgentPluginError,
  MCP_SCHEMA_ID,
  PLUGIN_SCHEMA_ID,
  readPluginSchemas,
  ruleOf,
  validateManifest,
} from './manifest.ts';

const schemas = await readPluginSchemas();

/** The rule a manifest breaks, or null when it is accepted. */
function broken(raw: unknown): string | null {
  try {
    validateManifest(raw, schemas.plugin, 'the-plugin');
    return null;
  } catch (error) {
    if (error instanceof AgentPluginError) {
      expect(error.message).toContain('the-plugin');
      expect(error.message).toContain(error.rule);
      expect(error.code).toBe('plugin.invalid');
      return error.rule;
    }
    throw error;
  }
}

describe('the vendored schemas', () => {
  test('are the 1.0.0 schemas, by their canonical identifiers', () => {
    expect(schemas.plugin['$id']).toBe(PLUGIN_SCHEMA_ID);
    expect(schemas.mcp['$id']).toBe(MCP_SCHEMA_ID);
  });
});

describe('validateManifest', () => {
  test("accepts the specification's minimal and full examples (§5.2)", () => {
    expect(validateManifest(MINIMAL_MANIFEST, schemas.plugin, 'p')).toEqual({
      manifest: { name: 'minimal-plugin', version: undefined, description: undefined },
      notices: [],
    });
    expect(validateManifest(FULL_MANIFEST, schemas.plugin, 'p').manifest).toEqual({
      name: 'plugin-name',
      version: '1.2.0',
      description: 'Brief plugin description',
    });
  });

  test('accepts every name §5.5 lists as valid and refuses every one it lists as invalid', () => {
    for (const name of VALID_NAMES) {
      expect(broken({ ...MINIMAL_MANIFEST, name })).toBeNull();
    }
    expect(broken({ ...MINIMAL_MANIFEST, name: 'a'.repeat(64) })).toBeNull();
    for (const name of INVALID_NAMES) {
      expect(broken({ ...MINIMAL_MANIFEST, name })).toMatch(/^§5\.5 name: (?:pattern|minLength)$/u);
    }
    expect(broken({ ...MINIMAL_MANIFEST, name: 'a'.repeat(65) })).toBe('§5.5 name: maxLength');
    expect(broken({ ...MINIMAL_MANIFEST, name: 7 })).toBe('§5.5 name: type');
  });

  test('a manifest that is not an object is refused (§5.2)', () => {
    expect(broken([MINIMAL_MANIFEST])).toBe('§5.2 manifest: type');
    expect(broken('plugin')).toBe('§5.2 manifest: type');
    expect(broken(null)).toBe('§5.2 manifest: type');
  });

  test('a missing required field is refused (§5.3)', () => {
    expect(broken({ name: 'no-schema' })).toBe('§5.3 required');
    expect(broken({ $schema: PLUGIN_SCHEMA_ID })).toBe('§5.3 required');
    expect(broken({ ...MINIMAL_MANIFEST, $schema: 1 })).toBe('§5.3 $schema: const');
  });

  test('another specification version is refused as unsupported (§5.2)', () => {
    const later = 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json';
    expect(broken({ ...MINIMAL_MANIFEST, $schema: later })).toBe(
      '§5.2 $schema: unsupported version',
    );
    expect(() =>
      validateManifest({ ...MINIMAL_MANIFEST, $schema: later }, schemas.plugin, 'p'),
    ).toThrow(/2\.0\.0/u);
  });

  test('metadata fields are checked by type only (§5.4)', () => {
    const odd = {
      version: 'not-semver',
      homepage: 'not a url',
      license: 'Custom',
      author: { email: 'x' },
    };
    expect(broken({ ...MINIMAL_MANIFEST, ...odd })).toBeNull();
    expect(broken({ ...MINIMAL_MANIFEST, version: 2 })).toBe('§5.4 version: type');
    expect(broken({ ...MINIMAL_MANIFEST, keywords: ['a', 1] })).toBe('§5.4 keywords/1: type');
    expect(broken({ ...MINIMAL_MANIFEST, author: { name: 'A', twitter: '@a' } })).toBe(
      '§5.4 author/twitter: false',
    );
    expect(broken({ ...MINIMAL_MANIFEST, author: 'A' })).toBe('§5.4 author: type');
  });

  test('an unknown top-level field is reported and ignored (§5.2)', () => {
    const outcome = validateManifest(
      { ...MINIMAL_MANIFEST, hooks: {}, mcpServers: {} },
      schemas.plugin,
      'p',
    );
    expect(outcome.manifest.name).toBe('minimal-plugin');
    expect(outcome.notices).toHaveLength(2);
    expect(outcome.notices.join(' ')).toContain('"hooks"');
    expect(outcome.notices.join(' ')).toContain('"mcpServers"');
  });

  test('extensions that is not an object is reported and ignored; a bad entry is fatal (§8.1)', () => {
    const outcome = validateManifest(
      { ...MINIMAL_MANIFEST, extensions: ['x'] },
      schemas.plugin,
      'p',
    );
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]).toContain('extensions');
    expect(broken({ ...MINIMAL_MANIFEST, extensions: { 'com.example': true } })).toBe(
      '§8.1 extensions/com.example: type',
    );
    expect(
      broken({ ...MINIMAL_MANIFEST, extensions: { 'com.other': { anything: [1, 2] } } }),
    ).toBeNull();
  });
});

describe('ruleOf', () => {
  test('names a rule even without an error to read', () => {
    expect(ruleOf([])).toEqual({ rule: '§5.3 schema', detail: '' });
  });
});
