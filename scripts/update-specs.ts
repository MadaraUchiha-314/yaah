/** Regenerates every file under `specs/` from source. Run with `bun run specs:update`. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generatedSpecs, serializeSpec } from '../src/kernel/specs.ts';
import { API_MANIFEST_PATH, apiManifest } from './api.ts';

for (const [path, value] of Object.entries(generatedSpecs())) {
  // oxlint-disable-next-line no-await-in-loop -- a handful of small files, written in order
  await mkdir(dirname(path), { recursive: true });
  // oxlint-disable-next-line no-await-in-loop -- as above
  await writeFile(path, serializeSpec(value));
  console.log(`wrote ${path}`);
}

await mkdir(dirname(API_MANIFEST_PATH), { recursive: true });
await writeFile(API_MANIFEST_PATH, serializeSpec(await apiManifest()));
console.log(`wrote ${API_MANIFEST_PATH}`);
