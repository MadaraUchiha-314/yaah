import { afterEach, describe, expect, test } from 'bun:test';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scratchDir, skillMd, writeTree } from '../../../test/support/skills.ts';
import type { Json } from '../../kernel/json.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import type { ToolResult } from '../core/types.ts';
import { MAX_SKILL_FILE_BYTES, scanSkills } from './skill.ts';
import { createSkillTools } from './tools.ts';

let scratch = '';

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function tree(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  scratch = await scratchDir('yaah-skill-');
  const root = join(scratch, 'skills');
  await writeTree(root, files);
  return root;
}

const about = { taskId: 't', callId: 'c', key: 'k', signal: new AbortController().signal };

function errorCode(result: ToolResult | undefined): string {
  return result?.ok === false ? result.error.code : '';
}

describe('scanSkills', () => {
  test('finds the skills that are immediate children, sorted, and nothing deeper', async () => {
    const root = await tree({
      'returns/SKILL.md': skillMd('returns', 'Handles returns.', '# Returns\n'),
      'billing/SKILL.md': skillMd('billing', 'Explains invoices.', 'Body.'),
      'billing/nested/deeper/SKILL.md': skillMd('deeper', 'Too deep.', ''),
      'not-a-skill/notes.md': 'no SKILL.md here',
      'README.md': 'a file, not a directory',
      'folder/SKILL.md/placeholder': 'SKILL.md is a directory here',
    });
    const { skills, refused } = await scanSkills(root);
    expect(skills.map((skill) => skill.name)).toEqual(['billing', 'returns']);
    expect(refused).toEqual([]);
    const [billing] = skills;
    expect(billing?.ref).toEqual({ kind: 'skill', id: 'billing', version: null });
    expect(billing?.description).toBe('Explains invoices.');
    expect(await billing?.loadBody()).toBe('Body.');
  });

  test('a skill that breaks a rule is refused by name and does not stop the others', async () => {
    const root = await tree({
      'good/SKILL.md': skillMd('good', 'Fine.', ''),
      'bad-name/SKILL.md': skillMd('Bad_Name', 'Wrong name.', ''),
      'no-front/SKILL.md': '# No front matter\n',
    });
    await symlink(join(root, 'missing-target'), join(root, 'dangling'));
    const { skills, refused } = await scanSkills(root);
    expect(skills.map((skill) => skill.name)).toEqual(['good']);
    expect(refused.map((refusal) => [refusal.path, refusal.rule])).toEqual([
      [join(root, 'bad-name'), 'name.characters'],
      [join(root, 'dangling'), 'path.missing'],
      [join(root, 'no-front'), 'frontmatter.missing'],
    ]);
    expect(refused[0]?.message).toContain('bad-name');
    expect(refused[0]?.message).toContain('name.characters');
  });

  test('a root that does not exist is an error for the caller', async () => {
    scratch = await scratchDir('yaah-skill-');
    const error: unknown = await scanSkills(join(scratch, 'absent')).catch(
      (reason: unknown) => reason,
    );
    expect(error instanceof Error ? error.message : '').toContain('does not exist');
  });
});

describe('skill tools', () => {
  async function tools(files: Readonly<Record<string, string | Uint8Array>>) {
    const root = await tree(files);
    const registry = new EntityRegistry();
    for (const skill of (await scanSkills(root)).skills) {
      registry.register(skill);
    }
    const [load, read] = createSkillTools(registry);
    return {
      root,
      load: (name: string) => load?.invoke({ name }, about),
      read: (name: string, path: Json) => read?.invoke({ name, path }, about),
    };
  }

  test('load_skill returns the body without the front matter', async () => {
    const { load } = await tools({
      'returns/SKILL.md': skillMd('returns', 'd', '# Steps\n1. Ask.'),
    });
    expect(await load('returns')).toEqual({
      ok: true,
      content: [{ type: 'text', text: '# Steps\n1. Ask.' }],
    });
  });

  test('an unknown skill is reported with the names that exist', async () => {
    const { load, read } = await tools({ 'returns/SKILL.md': skillMd('returns', 'd', '') });
    const result = await load('refunds');
    expect(errorCode(result)).toBe('not-found');
    expect(result?.ok === false ? result.error.message : '').toContain('returns');
    expect(errorCode(await read('refunds', 'a.md'))).toBe('not-found');
    expect(errorCode(await read('returns', 42))).toBe('skill.file.not-file');
  });

  test('a skill whose file vanished is reported, not thrown', async () => {
    const { root, load } = await tools({ 'returns/SKILL.md': skillMd('returns', 'd', '') });
    await rm(join(root, 'returns', 'SKILL.md'));
    expect(errorCode(await load('returns'))).toBe('failed');
    await writeFile(join(root, 'returns', 'SKILL.md'), 'no front matter');
    expect(errorCode(await load('returns'))).toBe('skill.invalid');
  });

  test('read_skill_file returns text and refuses everything else', async () => {
    const { read } = await tools({
      'returns/SKILL.md': skillMd('returns', 'd', ''),
      'returns/references/policy.md': 'Thirty days.',
      'returns/scripts/run.sh': '#!/bin/sh\necho hi\n',
      'returns/assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
      'returns/assets/nul.txt': 'a\u0000b',
      'returns/assets/big.txt': 'x'.repeat(MAX_SKILL_FILE_BYTES + 1),
    });
    expect(await read('returns', 'references/policy.md')).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'Thirty days.' }],
    });
    const script = await read('returns', 'scripts/run.sh');
    expect(script?.ok === true ? script.content : []).toEqual([
      { type: 'text', text: '#!/bin/sh\necho hi\n' },
    ]);
    expect(errorCode(await read('returns', 'assets/logo.png'))).toBe('unsupported');
    expect(errorCode(await read('returns', 'assets/nul.txt'))).toBe('unsupported');
    expect(errorCode(await read('returns', 'assets/big.txt'))).toBe('skill.file.too-large');
    expect(errorCode(await read('returns', 'references'))).toBe('skill.file.not-file');
    expect(errorCode(await read('returns', 'references/absent.md'))).toBe('path.missing');
    const outside = await read('returns', String.raw`C:\Windows\win.ini`);
    expect(errorCode(outside)).toBe('path.escape');
    expect(outside?.ok === false ? outside.error.message : '').not.toContain(scratch);
  });
});
