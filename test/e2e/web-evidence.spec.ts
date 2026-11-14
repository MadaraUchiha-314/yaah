import { fileURLToPath } from 'node:url';

import { test } from '@playwright/test';

import { STATES, open } from './web-pages.ts';

/**
 * Writes the screenshots kept as evidence: every state, in the light theme, the dark
 * theme, and a 400 px wide window. Runs only when asked to:
 *
 *   YAAH_UPDATE_EVIDENCE=1 bun run test:e2e
 */
const EVIDENCE = fileURLToPath(new URL('../../docs/specs/issue-3/evidence/ui/', import.meta.url));

const VARIANTS = [
  { theme: 'light', scheme: 'light', width: 1100 },
  { theme: 'dark', scheme: 'dark', width: 1100 },
  { theme: 'narrow', scheme: 'light', width: 400 },
] as const;

test.describe('evidence screenshots', () => {
  test.skip(process.env['YAAH_UPDATE_EVIDENCE'] === undefined, 'set YAAH_UPDATE_EVIDENCE=1');

  for (const variant of VARIANTS) {
    for (const [state, reach] of Object.entries(STATES)) {
      test(`web-${state}-${variant.theme}`, async ({ page }) => {
        await page.setViewportSize({ width: variant.width, height: 760 });
        await page.emulateMedia({ colorScheme: variant.scheme });
        await open(page);
        await reach(page);
        if (state !== 'streaming') {
          // Let colour transitions and the end of the turn settle before the picture.
          await page.waitForTimeout(600);
        }
        await page.screenshot({ path: `${EVIDENCE}web-${state}-${variant.theme}.png` });
      });
    }
  }
});
