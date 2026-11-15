import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { expectState, open, say } from './web-pages.ts';

/**
 * Chromium answering every microphone prompt "deny": the page's real `getUserMedia`
 * rejects with `NotAllowedError`, as it does when a person refuses.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
  },
});

/**
 * Feature: Web renderer
 * Scenario: A denied microphone is said in words and text input still works
 *   Given the chat open in a browser that denies the microphone
 *   When the user presses the microphone button
 *   Then the page says that microphone access was denied, as an alert
 *   And nothing is recorded or sent
 *   And a typed message is sent and answered as before
 * Requirement: docs/specs/issue-3/requirements.md R24.6
 */
test('A denied microphone is said in words and text input still works', async ({ page }) => {
  await open(page);
  const mic = page.locator('[data-slot="mic"]');
  await mic.click();
  const problem = page.locator('[data-slot="mic-problem"]');
  await expect(problem).toHaveText(t('web.voice.problem.denied'));
  await expect(problem).toHaveAttribute('role', 'alert');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  expect(await page.locator('[data-slot="file"]').count()).toBe(0);

  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="answer"]')).toContainText('within three working days.');
  await expectState(page, 'awaiting-next-interaction');
});
