/**
 * The composition the page starts its harness from.
 *
 * `bun run build:browser` replaces the content of this module with what it resolved from
 * `src/compositions/browser.yml`: a static import of every plugin, in order, and the
 * shipped prompts as text. What is written here is only the shape — a page bundled
 * without that build has an empty harness.
 */
import type { BrowserComposition } from '../harness.ts';

/** The browser composition, resolved at build time. */
export const composition: BrowserComposition = { entries: [], prompts: {} };
