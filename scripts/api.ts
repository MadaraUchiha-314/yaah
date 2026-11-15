/**
 * The package's export list: every subpath (a directory of `src/` with an `index.ts`)
 * and the names it exports at run time. Published as `specs/api/exports.json`, so adding,
 * renaming or removing a public name shows up in review as a diff of that file.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

async function indexFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => indexFiles(join(dir, entry.name))),
  );
  const own = entries.some((entry) => entry.isFile() && entry.name === 'index.ts')
    ? [join(dir, 'index.ts')]
    : [];
  return [...own, ...nested.flat()];
}

/** The subpath a file is imported by: `.` for the root, `./kernel` for `src/kernel/index.ts`. */
function subpathOf(file: string): string {
  const dir = relative(SRC, join(file, '..')).split(sep).join('/');
  return dir === '' ? '.' : `./${dir}`;
}

/** Every subpath of the package and the names it exports, both sorted. */
export async function apiManifest(): Promise<Record<string, string[]>> {
  const files = await indexFiles(SRC);
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, string[]]> => {
      const module: unknown = await import(pathToFileURL(file).href);
      const names = typeof module === 'object' && module !== null ? Object.keys(module) : [];
      return [subpathOf(file), names.toSorted()];
    }),
  );
  return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Where the manifest is checked in. */
export const API_MANIFEST_PATH = 'specs/api/exports.json';
