/**
 * Build script: compiles `src/` file by file into `dist/` with `tsc` (JavaScript and
 * type declarations, the same layout as the sources), then copies what is shipped beside
 * the code — compositions, prompts — rewriting the plugin names in compositions from
 * `.ts` to `.js`. The result runs on Node and Bun without a bundler. Run via
 * `bun run build`.
 */
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const OUT_DIR = 'dist';
// The web UI is built into dist/web by its own script; keep it across builds.
const KEEP = new Set(['web']);

for (const entry of await readdir(OUT_DIR).catch(() => [])) {
  if (!KEEP.has(entry)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of directories
    await rm(join(OUT_DIR, entry), { recursive: true, force: true });
  }
}

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (tsc.exitCode !== 0) {
  process.exit(tsc.exitCode);
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> =>
      entry.isDirectory() ? files(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]),
    ),
  );
  return nested.flat();
}

/** Copies one shipped file; returns whether it was one. */
async function ship(source: string): Promise<boolean> {
  const target = join(OUT_DIR, source.slice('src/'.length));
  if (/\.ya?ml$/u.test(source)) {
    const text = await readFile(source, 'utf8');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text.replaceAll(/(name:\s*\S+)\.tsx?(\s*)$/gmu, '$1.js$2'));
    return true;
  }
  if (/\.(?:md|json)$/u.test(source)) {
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    return true;
  }
  return false;
}

const shipped = await Promise.all((await files('src')).map((source) => ship(source)));
await chmod(join(OUT_DIR, 'cli', 'bin.js'), 0o755);

console.log(`Built ${OUT_DIR}/ (${String(shipped.filter(Boolean).length)} asset file(s) copied)`);
