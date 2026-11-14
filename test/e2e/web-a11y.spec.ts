import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { STATES, action, expectState, input, open } from './web-pages.ts';

/** The axe findings that fail the build: WCAG 2.1 A and AA rules, serious or critical. */
async function blockingViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
    );
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [state, reach] of Object.entries(STATES)) {
    /**
     * Feature: Web renderer
     * Scenario: Every state passes an automated accessibility check
     *   Given the chat in one of its states, in the light or the dark theme
     *   When axe checks the page against WCAG 2.1 A and AA
     *   Then it finds no serious or critical violation
     * Requirement: docs/specs/issue-3/requirements.md R20.6
     */
    test(`@a11y axe finds nothing serious: ${state}, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await open(page);
      await reach(page);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 40; presses += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one key press at a time
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${String(target)}.`);
}

/**
 * Feature: Web renderer
 * Scenario: The whole flow works with the keyboard alone
 *   Given the chat open, and no pointer
 *   When the user types a request and presses Enter
 *   And tabs to the form the agent sent, fills it in, and presses its button
 *   And tabs to "Complete task" and presses Enter
 *   Then the form was submitted and the task is completed
 *   And every control that took the focus showed a visible focus indicator
 * Requirement: docs/specs/issue-3/requirements.md R20.6
 */
test('@a11y send, fill the form and complete with the keyboard only', async ({ page }) => {
  await open(page);
  // The input has the focus when the page opens.
  await expect(input(page)).toBeFocused();
  await page.keyboard.type('Show me the refund form');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('please');
  await expect(input(page)).toHaveValue('Show me the refund form\nplease');
  await page.keyboard.press('Enter');
  await expectState(page, 'awaiting-next-interaction');

  const focusRings: boolean[] = [];
  const noteFocus = async (): Promise<void> => {
    focusRings.push(
      await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement ?? document.body);
        return (
          (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
          style.boxShadow !== 'none'
        );
      }),
    );
  };
  await tabTo(page, page.getByRole('textbox', { name: 'What happened?' }));
  await noteFocus();
  await page.keyboard.type('Arrived damaged');
  await tabTo(page, page.getByRole('checkbox', { name: 'I can send a photo of the damage' }));
  await noteFocus();
  await page.keyboard.press('Space');
  await tabTo(page, page.getByRole('button', { name: 'Submit refund' }));
  await noteFocus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-slot="answer"]').last()).toContainText('The refund is filed.');

  await tabTo(page, action(page, 'complete'));
  await noteFocus();
  await page.keyboard.press('Enter');
  await expectState(page, 'completed');
  await expect(action(page, 'complete')).toBeDisabled();
  expect(focusRings).toEqual([true, true, true, true]);
});

/**
 * Feature: Web renderer
 * Scenario: The controls of a later slice explain themselves to a keyboard user
 *   Given the chat open
 *   When the user tabs to the attach and the microphone buttons
 *   Then each is marked disabled and shows the tooltip "coming later"
 * Requirement: docs/specs/issue-3/requirements.md R20.6
 */
test('@a11y the attach and microphone buttons are inert and say why', async ({ page }) => {
  await open(page);
  for (const key of ['web.attach.label', 'web.voice.label']) {
    const button = page.getByRole('button', { name: t(key) });
    // oxlint-disable-next-line no-await-in-loop -- one control at a time
    await tabTo(page, button);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(button).toBeDisabled();
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(page.getByText(t('web.later'), { exact: true })).toBeVisible();
  }
});

/**
 * Feature: Web renderer
 * Scenario: The page fits a 400 px wide window
 *   Given a window 400 px wide
 *   When the chat shows a conversation with a form
 *   Then nothing scrolls sideways and the composer stays at the bottom of the window
 * Requirement: docs/specs/issue-3/requirements.md R20.1
 */
test('@a11y the layout holds at 400 px', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 760 });
  await open(page);
  await STATES['form']?.(page);
  const layout = await page.evaluate(() => {
    const field = document.querySelector('textarea');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      composerBottom: field?.getBoundingClientRect().bottom ?? 0,
      height: window.innerHeight,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.height);
  expect(layout.composerBottom).toBeGreaterThan(layout.height - 160);
});
