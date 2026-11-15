import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import type { Terminal } from './terminal.ts';
import { KEY, startTerminal, terminalPage } from './terminal.ts';

const EVIDENCE = fileURLToPath(new URL('../../docs/specs/issue-3/evidence/ui/', import.meta.url));
const keep = process.env['YAAH_UPDATE_EVIDENCE'] !== undefined;
const url = (): string => process.env['YAAH_E2E_URL'] ?? '';

let terminal: Terminal | undefined = undefined;

test.afterEach(() => {
  terminal?.kill();
  terminal = undefined;
});

/**
 * Feature: Terminal UI
 * Scenario: A whole conversation on a real terminal
 *   Given the terminal chat running on a pseudo-terminal against a harness
 *   When the user sends a message that needs tools, is asked a question and answers it,
 *        is shown a form and submits it with the keyboard, and completes the task
 *   Then the screen shows each tool with its outcome, the question in its own box, the
 *        form's fields, the state in words at every step, and finally the task completed
 *   And `/exit` leaves with exit code 0
 * Requirement: docs/specs/issue-3/requirements.md R21.1, R21.3, R19.4, R14.2–14.4, R23.2
 */
test('A whole conversation on a real terminal', async ({ page }) => {
  await terminalPage(page);
  terminal = startTerminal(url());
  const snap = async (state: string): Promise<void> => {
    if (keep) {
      await terminal?.picture(page, `${EVIDENCE}tui-${state}.png`);
    }
  };

  expect(await terminal.screen(page, 'Type a message')).toContain('Type a message');
  await snap('empty');

  await terminal.type('/mo');
  expect(await terminal.screen(page, '/model')).toContain('/model');
  await snap('command');
  for (const _ of '/mo') {
    // oxlint-disable-next-line no-await-in-loop -- keys are pressed one after another
    await terminal.type('\u007F');
  }

  await terminal.type('please look up my order');
  await terminal.type(KEY.enter);
  const tools = await terminal.screen(page, 'Waiting for you');
  expect(tools).toContain('lookup_order');
  expect(tools).toMatch(/refund_rules.*failed|✗ refund_rules/u);
  expect(tools).toContain('I found the order');
  await snap('tools');

  await terminal.type('ask me something');
  await terminal.type(KEY.enter);
  const ask = await terminal.screen(page, 'Refund or store credit?');
  expect(ask).toContain('Needs your input');
  await snap('ask');

  await terminal.type('a refund');
  await terminal.type(KEY.enter);
  expect(await terminal.screen(page, 'A supervisor will approve')).toContain('Waiting for you');

  await terminal.type('show me the refund form');
  await terminal.type(KEY.enter);
  const form = await terminal.screen(page, 'Submit refund');
  expect(form).toContain('What happened?');
  expect(form).toContain('I can send a photo');
  await snap('form');

  // Tab to the text field, type, Tab to the checkbox, tick it, Tab to the button, press it.
  await terminal.type(KEY.tab);
  await terminal.type('arrived cracked');
  await terminal.type(KEY.tab);
  await terminal.type(KEY.space);
  await terminal.type(KEY.tab);
  await terminal.type(KEY.enter);
  expect(await terminal.screen(page, 'The refund is filed')).toContain('The refund is filed');

  await terminal.type(KEY.tab);
  await terminal.type(KEY.ctrlD);
  expect(await terminal.screen(page, 'Completed')).toContain('Completed');
  await snap('completed');

  await terminal.type('/exit');
  await terminal.type(KEY.enter);
  expect(await terminal.exited).toBe(0);
});
