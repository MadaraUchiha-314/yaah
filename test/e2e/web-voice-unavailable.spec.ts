import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { open, say } from './web-pages.ts';

/**
 * Feature: Web renderer
 * Scenario: A browser that cannot capture audio says so and text input still works
 *   Given the chat open in a browser with no audio capture at all (headless, no device)
 *   When the user presses the microphone button
 *   Then the page says no microphone is available
 *   And a typed message is sent and answered as before
 * Requirement: docs/specs/issue-3/requirements.md R24.6
 */
test('A browser that cannot capture audio says so and text input still works', async ({ page }) => {
  await open(page);
  await page.locator('[data-slot="mic"]').click();
  await expect(page.locator('[data-slot="mic-problem"]')).toHaveText(
    t('web.voice.problem.unavailable'),
  );
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="answer"]')).toContainText('within three working days.');
});

/**
 * Feature: Web renderer
 * Scenario: A browser without a microphone API says so and text input still works
 *   Given the chat open in a browser that has no getUserMedia
 *   When the user presses the microphone button
 *   Then the page says no microphone is available
 *   And a typed message is sent and answered as before
 * Requirement: docs/specs/issue-3/requirements.md R24.6
 */
test('A browser without a microphone API says so and text input still works', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });
  await open(page);
  await page.locator('[data-slot="mic"]').click();
  await expect(page.locator('[data-slot="mic-problem"]')).toHaveText(
    t('web.voice.problem.unavailable'),
  );
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="answer"]')).toContainText('within three working days.');
});
