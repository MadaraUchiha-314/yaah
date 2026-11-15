/**
 * End-to-end tests of the web chat (`bun run test:e2e`): a real harness with a scripted
 * model, driven through Chromium. The specs are run by Node, by Playwright's own runner —
 * neither `bun test` nor Vitest picks them up.
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import { defineConfig, devices } from '@playwright/test';

const config: PlaywrightTestConfig = defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});

export default config;
