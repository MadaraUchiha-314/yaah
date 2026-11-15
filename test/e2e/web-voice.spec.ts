import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { expectState, input, open, pill, say } from './web-pages.ts';

/**
 * Chromium with a microphone that needs no hardware: a fake capture device, and
 * permission prompts answered "allow". The page still calls the real `getUserMedia`,
 * `MediaRecorder` and Web Audio.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
});

test.beforeEach(async ({ page }) => {
  await open(page);
});

/**
 * Feature: Web renderer
 * Scenario: The microphone button records a voice message and submits it as the turn
 *   Given the chat open in a browser with a microphone, on a harness with a
 *         speech-to-text model and a model that accepts text only
 *   When the user presses the microphone button, speaks, and presses it again
 *   Then the button shows that it is recording, and the input says so
 *   And the recording is sent as the user's turn and shown as a voice message
 *   And the agent answers what was said
 * Requirement: docs/specs/issue-3/requirements.md R24.4
 */
test('The microphone button records a voice message and submits it as the turn', async ({
  page,
}) => {
  const mic = page.locator('[data-slot="mic"]');
  await expect(mic).toHaveAccessibleName(t('web.voice.start'));
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(mic).toHaveAccessibleName(t('web.voice.stop'));
  await expect(input(page)).toHaveAttribute('placeholder', t('web.voice.recording'));
  await page.waitForTimeout(600);
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-slot="file"][data-from="user"]')).toContainText(
    t('view.file.voice'),
  );
  await expect(page.locator('[data-slot="answer"]')).toContainText('I heard you. It ships today.');
  await expectState(page, 'awaiting-next-interaction');
  await expect(page.locator('[data-slot="mic-problem"]')).toHaveCount(0);
});

/**
 * Feature: Web renderer
 * Scenario: With voice output on, the answer is played while it is still being written
 *   Given the chat open on a harness with a text-to-speech model
 *   When the user turns spoken answers on and sends a message
 *   Then audio is scheduled with Web Audio while the task still reads "Working"
 *   And the page says it is speaking
 *   And turning spoken answers off stops the playback
 * Requirement: docs/specs/issue-3/requirements.md R24.5
 */
test('With voice output on, the answer is played while it is still being written', async ({
  page,
}) => {
  const working = t('view.state.working');
  await page.evaluate((label) => {
    // Was there a moment when speech was playing and the task was still working?
    Reflect.set(window, 'spokeWhileWorking', false);
    new MutationObserver(() => {
      const speaking = document.querySelector('[data-slot="speaking"]') !== null;
      const state = document.querySelector('[data-slot="state-pill"]')?.textContent ?? '';
      if (speaking && state.includes(label)) {
        Reflect.set(window, 'spokeWhileWorking', true);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, working);

  const speak = page.locator('[data-slot="speak-toggle"]');
  await speak.click();
  await expect(speak).toHaveAttribute('aria-pressed', 'true');
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="speaking"]')).toHaveText(t('web.speak.playing'));
  await expectState(page, 'awaiting-next-interaction');
  expect(await page.evaluate(() => Reflect.get(window, 'spokeWhileWorking') === true)).toBe(true);
  await expect(page.locator('[data-slot="answer"]')).toContainText('within three working days.');

  await speak.click();
  await expect(page.locator('[data-slot="speaking"]')).toHaveCount(0);
  await expect(pill(page)).toHaveText(t('view.state.awaiting-next-interaction'));
});
