/**
 * Build script: bundles `src/` to ESM with `bun build`, then emits type
 * declarations with `tsc`. Run via `bun run build`.
 */
import { rm } from 'node:fs/promises';

const OUT_DIR = 'dist';

await rm(OUT_DIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: OUT_DIR,
  target: 'bun',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  splitting: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (tsc.exitCode !== 0) {
  process.exit(tsc.exitCode);
}

console.log(`Built ${String(result.outputs.length)} file(s) to ${OUT_DIR}/`);
