/** Builds skill and plugin directories in a temporary directory, for tests. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fresh temporary directory. */
export function scratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Writes `files` (relative path to content) under `root`, creating directories. */
export async function writeTree(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    // oxlint-disable-next-line no-await-in-loop -- a handful of small files
    await mkdir(dirname(target), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await writeFile(target, content);
  }
}

/** The text of a valid `SKILL.md`. */
export function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

/** `[skills]` configuration naming `paths`. */
export function skillsConfig(...paths: readonly string[]): string {
  return `[skills]\npaths = ${JSON.stringify(paths)}`;
}
