import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { STATES, action, expectState, input, modelCalls, open, pill, say } from './web-pages.ts';

test.beforeEach(async ({ page }) => {
  await open(page);
});

/**
 * Feature: Web renderer
 * Scenario: The web UI streams an answer and shows the task state
 *   Given the chat open on a harness with a model that answers word by word
 *   When the user sends a question
 *   Then the state reads "Working" while the answer arrives
 *   And the answer grows in several steps rather than appearing at once
 *   And the state reads "Waiting for you" when the task rests, with both controls enabled
 * Requirement: docs/specs/issue-3/requirements.md R20.2, R20.3
 */
test('The web UI streams an answer and shows the task state', async ({ page }) => {
  await expectState(page, 'idle');
  await expect(action(page, 'complete')).toBeDisabled();
  await expect(action(page, 'cancel')).toBeDisabled();
  // Record every length the answer has on its way to complete.
  await page.evaluate(() => {
    const lengths = new Set<number>();
    Reflect.set(window, 'answerLengths', lengths);
    new MutationObserver(() => {
      const answer = document.querySelector('[data-slot="answer"]');
      lengths.add(answer?.textContent.length ?? 0);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="user-message"]')).toHaveText('Where is my order?');
  await expectState(page, 'working');
  await expect(page.locator('[data-slot="answer"]')).toContainText('within three working days.');
  await expectState(page, 'awaiting-next-interaction');
  const steps = await page.evaluate(() => {
    const lengths: unknown = Reflect.get(window, 'answerLengths');
    return lengths instanceof Set ? lengths.size : 0;
  });
  expect(steps).toBeGreaterThan(5);
  await expect(page.locator('[data-slot="answer"]')).toHaveAttribute('data-streaming', 'false');
  await expect(action(page, 'complete')).toBeEnabled();
  await expect(action(page, 'cancel')).toBeEnabled();
  await expect(page.getByRole('log')).toHaveAttribute('aria-live', 'polite');
});

/**
 * Feature: Web renderer
 * Scenario: The agent asks for input and the request is visually distinct
 *   Given the chat open
 *   When the agent asks the user a question
 *   Then the question is in a labelled, tinted, bordered block unlike an ordinary answer
 *   And the state reads "Needs your input" and the input invites an answer
 *   And answering it continues the task
 * Requirement: docs/specs/issue-3/requirements.md R20.4, R14.5
 */
test('The agent asks for input and the request is visually distinct', async ({ page }) => {
  await STATES['ask']?.(page);
  const ask = page.locator('[data-slot="ask"]');
  await expect(ask).toContainText('Refund or store credit?');
  await expect(ask).toContainText(t('view.ask.label'));
  await expect(input(page)).toHaveAttribute('placeholder', t('view.input.placeholder.ask'));
  const look = await ask.evaluate((element) => {
    const style = getComputedStyle(element);
    const body = getComputedStyle(document.body);
    return {
      tinted: style.backgroundColor !== body.backgroundColor,
      bordered: style.borderTopWidth !== '0px' && style.borderTopColor !== body.color,
    };
  });
  expect(look).toEqual({ tinted: true, bordered: true });

  await say(page, 'A refund, please');
  await expect(page.locator('[data-slot="answer"]')).toContainText('A supervisor will approve');
  await expectState(page, 'awaiting-next-interaction');
});

/**
 * Feature: Web renderer
 * Scenario: Complete and Cancel end the task
 *   Given a task that rests after an answer
 *   When the user presses "Complete task"
 *   Then the task reads "Completed", both controls are disabled, and the input says so
 *   And a task the user cancels instead reads "Canceled"
 *   And a message typed after that starts a new task
 * Requirement: docs/specs/issue-3/requirements.md R20.3, R14.3
 */
test('Complete and Cancel end the task', async ({ page, context }) => {
  await STATES['completed']?.(page);
  await expect(action(page, 'complete')).toBeDisabled();
  await expect(action(page, 'cancel')).toBeDisabled();
  await expect(input(page)).toHaveAttribute('placeholder', t('view.input.placeholder.closed'));
  await say(page, 'One more thing: where is it now?');
  await expectState(page, 'awaiting-next-interaction');
  await expect(page.locator('[data-slot="answer"]')).toHaveCount(2);

  const other = await context.newPage();
  await open(other);
  await say(other, 'Where is my order?');
  await expectState(other, 'working');
  await action(other, 'cancel').click();
  await expectState(other, 'canceled');
  await expect(action(other, 'cancel')).toBeDisabled();
  await expect(other.getByRole('alert')).toHaveCount(0);
});

/**
 * Feature: Web renderer
 * Scenario: A matched command is highlighted and never reaches the model
 *   Given the chat open on a harness that lists /model and /effort
 *   When the user types a slash and an unknown word
 *   Then the commands are listed
 *   When the user types /model
 *   Then the input is drawn in the command colour and a hint says it is a command
 *   When the user sends it
 *   Then the harness's reply is shown as a note, and the model was not called
 * Requirement: docs/specs/issue-3/requirements.md R20.5, R23.1
 */
test('A matched command is highlighted and never reaches the model', async ({ page }) => {
  // A word no other test types, to find this test's messages among the model's calls.
  const marker = `only-here-${String(Date.now())}`;
  const colour = (): Promise<string> =>
    input(page).evaluate((field) => getComputedStyle(field).color);
  const plain = await colour();
  await input(page).fill('/nope');
  await expect(page.getByText(t('view.command.list', { names: '' }).trim())).toBeVisible();
  await expect(input(page)).toHaveAttribute('data-command', 'false');
  expect(await colour()).toBe(plain);

  await input(page).fill('/model');
  await expect(input(page)).toHaveAttribute('data-command', 'true');
  await expect(page.getByText(t('view.command.hint', { name: '/model' }))).toBeVisible();
  expect(await colour()).not.toBe(plain);

  await input(page).press('Enter');
  await expect(page.locator('[data-slot="note"]')).toContainText('scripted/model');
  await expect(page.locator('[data-slot="user-message"] [data-slot="command"]')).toHaveText(
    '/model',
  );
  await expect(page.locator('[data-slot="agent-turn"]')).toHaveCount(0);
  await expectState(page, 'idle');
  await say(page, `/effort ${marker}`);
  await expect(page.locator('[data-slot="note"]').last()).toContainText(marker);
  expect(await modelCalls(page, marker)).toBe(0);
  // An ordinary message with the same word does reach it: the count is not blind.
  await say(page, `Where is my order ${marker}?`);
  await expectState(page, 'awaiting-next-interaction');
  expect(await modelCalls(page, marker)).toBe(1);

  // The chips write the command for the user.
  await page.locator('[data-slot="chip"]', { hasText: '/effort' }).click();
  await expect(input(page)).toHaveValue('/effort ');
  await expect(input(page)).toBeFocused();
});

/**
 * Feature: Surfaces and renderers
 * Scenario: A basic-catalog A2UI form is drawn and its button sends an action
 *   Given the chat open, offering the A2UI basic catalog
 *   When the agent answers with a form
 *   Then the form's text, field, checkbox and button are drawn by the A2UI renderer
 *   When the user fills it in and presses its button
 *   Then an A2UI 1.0 action message with the form's values is sent to the harness
 *   And the agent's reply to it is shown
 * Requirement: docs/specs/issue-3/requirements.md R19.4, R19.6
 */
test('A basic-catalog A2UI form is drawn and its button sends an action', async ({ page }) => {
  await STATES['form']?.(page);
  const form = page.locator('[data-slot="a2ui"]');
  await expect(form).toContainText('Refund details');
  await expect(page.locator('[data-slot="answer"]')).not.toContainText('<a2ui>');
  await form.getByLabel('What happened?').fill('Arrived damaged');
  await form.getByLabel('I can send a photo of the damage').check();
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && (request.postData() ?? '').includes('submitRefund'),
  );
  await form.getByRole('button', { name: 'Submit refund' }).click();
  const body = (await sent).postData() ?? '';
  expect(body).toContain('"version":"1.0"');
  expect(body).toContain('"name":"submitRefund"');
  expect(body).toContain('"note":"Arrived damaged"');
  expect(body).toContain('"photo":true');
  expect(body).toContain('application/a2ui+json');
  await expect(page.locator('[data-slot="answer"]').last()).toContainText('The refund is filed.');
});

/**
 * Feature: Surfaces and renderers
 * Scenario: A hostile A2UI surface falls back to text
 *   Given an agent that sends a surface with a component the catalog does not have
 *   When the answer is drawn
 *   Then a line of text stands where the surface would be, naming the component
 *   And what the agent said before and after it is shown
 *   And nothing the surface carried ran, and the page reported no error
 * Requirement: docs/specs/issue-3/requirements.md R19.5; abuse case 5
 */
test('A hostile A2UI surface falls back to text', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await STATES['hostile']?.(page);
  const turn = page.locator('[data-slot="agent-turn"]');
  await expect(turn).toContainText('Before the surface.');
  await expect(turn).toContainText('After the surface.');
  await expect(turn).toContainText(t('view.a2ui.fallback', { component: 'ScriptTag' }));
  await expect(page.locator('[data-slot="a2ui"]')).toHaveCount(0);
  await expect(page.locator('img')).toHaveCount(0);
  await expect(turn).not.toContainText('__pwned');
  expect(await page.evaluate((): unknown => Reflect.get(window, '__pwned'))).toBeUndefined();
  expect(errors).toEqual([]);
  // The conversation goes on.
  await say(page, 'Where is my order?');
  await expect(page.locator('[data-slot="answer"]').last()).toContainText('It ships today.');
  await expect(pill(page)).toHaveText(t('view.state.awaiting-next-interaction'));
});

/**
 * Feature: Web renderer
 * Scenario: Tool calls are grouped, and a failed one says so
 *   Given an agent that runs two tools, one of which fails
 *   When the answer is drawn
 *   Then one group lists both calls with outcome and duration, and can be folded
 * Requirement: docs/specs/issue-3/requirements.md R20.1, R8.5
 */
test('Tool calls are grouped, and a failed one says so', async ({ page }) => {
  await STATES['tools']?.(page);
  const group = page.locator('[data-slot="tool-group"]');
  await expect(group).toContainText(t('web.tools.summary', { count: 2 }));
  await expect(group).toContainText(t('web.tools.failed', { count: 1 }));
  const calls = group.locator('[data-slot="tool-call"]');
  await expect(calls).toHaveCount(2);
  await expect(calls.filter({ hasText: 'lookup_order' })).toContainText(t('view.tool.ok'));
  await expect(calls.filter({ hasText: 'refund_rules' })).toContainText(t('view.tool.failed'));
  await group.getByRole('button').click();
  await expect(calls).toHaveCount(0);
});
