import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { STATES, attach, expectState, input, open, sampleImage, say } from './web-pages.ts';

test.beforeEach(async ({ page }) => {
  await open(page);
});

/**
 * Feature: Web renderer
 * Scenario: An attached image is shown before sending and reaches the model
 *   Given the chat open on a harness whose model accepts images
 *   When the user picks an image with the attach button's file picker
 *   Then a thumbnail of it appears above the input before anything is sent
 *   When the user sends it with a question
 *   Then the image is drawn in the conversation as the user's
 *   And the model answers about the image it was shown
 * Requirement: docs/specs/issue-3/requirements.md R24.1
 */
test('An attached image is shown before sending and reaches the model', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: t('web.attach.label') }).click();
  await (await chooser).setFiles(sampleImage());
  const thumbnail = page.locator('[data-slot="attachment"] img');
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute('alt', 'lamp.png');
  expect(await page.locator('[data-slot="user-message"]').count()).toBe(0);

  await say(page, 'What is this?');
  await expect(thumbnail).toHaveCount(0);
  const sent = page.locator('[data-slot="image"][data-from="user"] img');
  await expect(sent).toBeVisible();
  expect(await sent.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  await expect(page.locator('[data-slot="answer"]')).toContainText(
    'I can see the image you attached.',
  );
  await expectState(page, 'awaiting-next-interaction');
});

/**
 * Feature: Web renderer
 * Scenario: An image pasted into the input is attached, and can be removed
 *   Given the chat open
 *   When the user pastes an image from the clipboard into the input
 *   Then it appears as a thumbnail
 *   And its remove button takes it away again
 * Requirement: docs/specs/issue-3/requirements.md R24.1
 */
test('An image pasted into the input is attached, and can be removed', async ({ page }) => {
  const image = sampleImage('pasted.png');
  await input(page).focus();
  await page.evaluate(
    ({ bytes, name }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(bytes)], name, { type: 'image/png' }));
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { bytes: [...image.buffer], name: image.name },
  );
  await expect(page.locator('[data-slot="attachment"] img')).toHaveAttribute('alt', 'pasted.png');
  await page.getByRole('button', { name: t('web.attach.remove', { name: 'pasted.png' }) }).click();
  await expect(page.locator('[data-slot="attachment"]')).toHaveCount(0);
});

/**
 * Feature: Web renderer
 * Scenario: An attachment over the server's limit is refused with the server's reason
 *   Given a harness that accepts parts of at most 300000 bytes
 *   When the user sends an image larger than that
 *   Then the page shows the server's message, which states the limit
 *   And a text message still goes through afterwards
 * Requirement: docs/specs/issue-3/requirements.md R24.1, R26.4
 */
test("An attachment over the server's limit is refused with the server's reason", async ({
  page,
}) => {
  const big = { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(400_000, 7) };
  await attach(page, big);
  await expect(page.locator('[data-slot="attachment"]')).toHaveCount(1);
  await say(page, 'Too big?');
  await expect(page.getByRole('alert')).toContainText(
    t('server.limit.part-size', { limit: 300_000 }),
  );
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="answer"]')).toContainText('It ships today.');
});

/**
 * Feature: Web renderer
 * Scenario: An image the agent makes is drawn in the conversation
 *   Given the chat open on a harness with a tool that makes an image
 *   When the user asks for a picture
 *   Then the image arrives as an artifact and is drawn inside the agent's turn
 *   And it is loaded from inline image data, with its name as alternative text
 *   And the answer text follows it
 * Requirement: docs/specs/issue-3/requirements.md R24.2
 */
test('An image the agent makes is drawn in the conversation', async ({ page }) => {
  await STATES['image']?.(page);
  const image = page.locator('[data-slot="agent-turn"] [data-slot="image"] img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('alt', 'lamp.png');
  expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/u);
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(96);
  await expect(page.locator('[data-slot="image"]')).toContainText(t('view.file.image'));
  await expect(page.locator('[data-slot="answer"]')).toContainText(
    'Here is the lamp you asked for.',
  );
});
