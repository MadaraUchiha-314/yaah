import { describe, expect, test } from 'bun:test';

import type { SkillRule } from './frontmatter.ts';
import { SkillValidationError, splitSkillMd, validateFrontMatter } from './frontmatter.ts';

const VALID = { name: 'pdf-processing', description: 'Extracts text from PDF files.' };

/** The rule a front matter breaks, or null when it is valid. */
function ruleOf(front: unknown, directory = 'pdf-processing'): SkillRule | null {
  try {
    validateFrontMatter(front, directory);
    return null;
  } catch (error) {
    if (error instanceof SkillValidationError) {
      expect(error.message).toContain(error.rule);
      expect(error.message).toContain(directory);
      return error.rule;
    }
    throw error;
  }
}

describe('splitSkillMd', () => {
  test('separates the front matter from the body', () => {
    const text = '---\nname: a\ndescription: b\n---\n# Title\n\nBody.\n';
    expect(splitSkillMd(text, 'a')).toEqual({
      front: { name: 'a', description: 'b' },
      body: '# Title\n\nBody.\n',
    });
  });

  test('accepts a byte-order mark, CRLF line ends and an empty block', () => {
    expect(splitSkillMd('﻿---\r\nname: a\r\n---\r\nBody', 'a')).toEqual({
      front: { name: 'a' },
      body: 'Body',
    });
    expect(splitSkillMd('---\n---\n', 'a')).toEqual({ front: null, body: '' });
  });

  test('a file without front matter breaks frontmatter.missing', () => {
    expect(() => splitSkillMd('# Just markdown\n', 'a')).toThrow(/frontmatter\.missing/u);
    expect(() => splitSkillMd('---\nname: a\n', 'a')).toThrow(/frontmatter\.missing/u);
  });

  test('a block that is not YAML breaks frontmatter.yaml', () => {
    expect(() => splitSkillMd('---\nname: [unclosed\n---\n', 'a')).toThrow(/frontmatter\.yaml/u);
  });
});

describe('validateFrontMatter', () => {
  test('returns a valid front matter typed, optional fields included', () => {
    const front = {
      ...VALID,
      license: 'Apache-2.0',
      compatibility: 'Requires git',
      metadata: { author: 'example-org', version: '1.0' },
      'allowed-tools': 'Bash(git:*)  Read',
      'x-unknown': 1,
    };
    expect(validateFrontMatter(front, 'pdf-processing')).toEqual({
      ...VALID,
      license: 'Apache-2.0',
      compatibility: 'Requires git',
      metadata: { author: 'example-org', version: '1.0' },
      allowedTools: ['Bash(git:*)', 'Read'],
    });
    expect(validateFrontMatter(VALID, 'pdf-processing').allowedTools).toEqual([]);
  });

  const cases: readonly (readonly [SkillRule, unknown, string?])[] = [
    ['frontmatter.mapping', null],
    ['frontmatter.mapping', ['name']],
    ['name.required', { description: 'x' }],
    ['name.type', { ...VALID, name: 42 }],
    ['name.length', { ...VALID, name: '' }, ''],
    ['name.length', { ...VALID, name: 'a'.repeat(65) }, 'a'.repeat(65)],
    ['name.characters', { ...VALID, name: 'PDF-Processing' }, 'PDF-Processing'],
    ['name.characters', { ...VALID, name: 'pdf_processing' }, 'pdf_processing'],
    ['name.characters', { ...VALID, name: 'pdf-é' }, 'pdf-é'],
    ['name.hyphen-edges', { ...VALID, name: '-pdf' }, '-pdf'],
    ['name.hyphen-edges', { ...VALID, name: 'pdf-' }, 'pdf-'],
    ['name.consecutive-hyphens', { ...VALID, name: 'pdf--processing' }, 'pdf--processing'],
    ['name.directory', { ...VALID, name: 'other' }],
    ['description.required', { name: 'pdf-processing' }],
    ['description.type', { ...VALID, description: ['a'] }],
    ['description.length', { ...VALID, description: '   ' }],
    ['description.length', { ...VALID, description: 'd'.repeat(1025) }],
    ['license.type', { ...VALID, license: 7 }],
    ['compatibility.type', { ...VALID, compatibility: true }],
    ['compatibility.length', { ...VALID, compatibility: '' }],
    ['compatibility.length', { ...VALID, compatibility: 'c'.repeat(501) }],
    ['metadata.type', { ...VALID, metadata: 'author' }],
    ['metadata.type', { ...VALID, metadata: { version: 1 } }],
    ['allowed-tools.type', { ...VALID, 'allowed-tools': ['Read'] }],
  ];

  for (const [rule, front, directory] of cases) {
    test(`${JSON.stringify(front).slice(0, 60)} breaks ${rule}`, () => {
      expect(ruleOf(front, directory)).toBe(rule);
    });
  }

  test('the limits themselves are allowed, counted in characters', () => {
    expect(ruleOf({ ...VALID, name: 'a'.repeat(64) }, 'a'.repeat(64))).toBeNull();
    expect(ruleOf({ ...VALID, description: '😀'.repeat(1024) })).toBeNull();
    expect(ruleOf({ ...VALID, compatibility: 'c'.repeat(500) })).toBeNull();
  });
});
