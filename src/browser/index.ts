/**
 * The browser build: a harness in a tab, with no yaah server process.
 *
 * {@link createBrowserHarness} starts one from a composition resolved at build time, and
 * `ctx.harnessTarget` reaches it through the {@link InMemoryTransport}. An application
 * that embeds yaah in its own page imports this subpath; `bun run build:browser` builds
 * the shipped page, the web chat on such a harness, into `dist/browser/`.
 */
export { createBrowserHarness } from './harness.ts';
export type {
  BrowserComposition,
  BrowserEntry,
  BrowserPlugin,
  CreateBrowserHarnessOptions,
} from './harness.ts';
export { IN_MEMORY_PROTOCOL, InMemoryTransport, connectInMemory } from './in-memory-transport.ts';
export { IN_MEMORY_URL } from './plugins/target.ts';
export type { InMemoryTargetConfig } from './plugins/target.ts';
export { CONFIG_FILE, pageOptions, startPageHarness } from './start.ts';
export type { PageOptions } from './start.ts';
export type { Credentials } from '../kernel/credentials.ts';
