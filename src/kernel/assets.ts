import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Locates the files shipped beside the code — prompts and compositions.
 *
 * In a source checkout this module is `src/kernel/assets.ts` and the files are its
 * siblings' siblings (`src/prompts`). In the built package the layout is the same under
 * `dist/`, so one relative step serves both.
 */
const ROOT = new URL('../', import.meta.url);

/** The absolute path of a shipped asset, e.g. `assetPath('prompts', 'system.md')`. */
export function assetPath(...segments: readonly string[]): string {
  return fileURLToPath(new URL(segments.join('/'), ROOT));
}

/** Whether a shipped asset exists. */
export function hasAsset(...segments: readonly string[]): boolean {
  return existsSync(assetPath(...segments));
}
