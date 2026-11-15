import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generatedSpecs, serializeSpec } from '../../src/kernel/specs.ts';

const repoFile = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

describe('published contracts under specs/', () => {
  for (const [path, value] of Object.entries(generatedSpecs())) {
    test(`${path} matches what the source generates`, async () => {
      const checkedIn = await readFile(repoFile(path), 'utf8');
      // A difference means a public contract changed. If that is intended, run
      // `bun run specs:update` and review the diff of specs/ as an interface change.
      expect(checkedIn).toBe(serializeSpec(value));
    });
  }
});
