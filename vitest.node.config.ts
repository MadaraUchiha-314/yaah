/**
 * Runs the same test files on Node (`bun run test:node`), so the package is proven on
 * both runtimes it supports. Tests import `bun:test`; here that name resolves to a shim
 * that re-exports the equivalent Vitest API.
 */
import { fileURLToPath } from 'node:url';

import type { ViteUserConfig } from 'vitest/config';
import { defineConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  resolve: {
    alias: { 'bun:test': fileURLToPath(new URL('test/node-shim.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/live/**', 'node_modules/**', 'dist/**'],
    testTimeout: 30_000,
  },
});

export default config;
