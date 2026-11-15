/**
 * Records the definition-of-done demo (`bun run demo:record`): one live harness, a real
 * model, the web chat and the terminal chat on the same task. Not part of any test run.
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import { defineConfig, devices } from '@playwright/test';

const config: PlaywrightTestConfig = defineConfig({
  testDir: 'test/demo',
  testMatch: '**/*.demo.ts',
  outputDir: 'test-results/demo',
  reporter: [['list']],
  timeout: 600_000,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1100, height: 760 },
    video: { mode: 'on', size: { width: 1100, height: 760 } },
  },
});

export default config;
