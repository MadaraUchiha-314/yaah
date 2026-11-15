import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveInside } from './paths.ts';
import { YaahError } from './yaah-error.ts';

function tree(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'yaah-paths-')));
  const root = join(base, 'root');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'file.md'), 'inside');
  writeFileSync(join(base, 'secret.txt'), 'outside');
  symlinkSync(join(base, 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(join(root, 'sub'), join(root, 'alias'));
  return { root, outside: join(base, 'secret.txt') };
}

async function codeOf(work: Promise<string>): Promise<string> {
  const outcome = await work.catch((error: unknown) => error);
  return outcome instanceof YaahError ? outcome.code : `resolved: ${String(outcome)}`;
}

describe('resolveInside', () => {
  test('returns the real path of what lies inside, links included', async () => {
    const { root } = tree();
    expect(await resolveInside(root, 'sub/file.md')).toBe(join(root, 'sub', 'file.md'));
    expect(await resolveInside(root, 'alias/file.md')).toBe(join(root, 'sub', 'file.md'));
    expect(await resolveInside(root, '.')).toBe(root);
  });

  test('refuses a relative climb, an absolute path and a link that leave the root', async () => {
    const { root, outside } = tree();
    expect(await codeOf(resolveInside(root, '../secret.txt'))).toBe('path.escape');
    expect(await codeOf(resolveInside(root, 'sub/../../secret.txt'))).toBe('path.escape');
    expect(await codeOf(resolveInside(root, outside))).toBe('path.escape');
    expect(await codeOf(resolveInside(root, 'link.txt'))).toBe('path.escape');
  });

  test('a path or a root that does not exist is refused too', async () => {
    const { root } = tree();
    expect(await codeOf(resolveInside(root, 'nope.md'))).toBe('path.missing');
    expect(await codeOf(resolveInside(join(root, 'ghost'), 'x'))).toBe('path.missing');
  });
});
