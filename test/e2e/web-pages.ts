/**
 * What the browser tests share: how to open the chat, say something, and bring the page
 * into each state the design shows.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import { solidPng } from '../support/png.ts';

/** Where the harness of this run listens. */
export function harnessUrl(): string {
  return process.env['YAAH_E2E_URL'] ?? '';
}

/** The message input. */
export function input(page: Page): Locator {
  return page.getByRole('textbox', { name: t('web.input.label') });
}

/** The pill that names the task's state. */
export function pill(page: Page): Locator {
  return page.locator('[data-slot="state-pill"]');
}

/** A header button, by its string key. */
export function action(page: Page, key: 'complete' | 'cancel' | 'send'): Locator {
  return page.getByRole('button', { name: t(`view.action.${key}`) });
}

/** Opens the chat and waits until it is connected. */
export async function open(page: Page): Promise<void> {
  await page.goto(harnessUrl());
  await expect(input(page)).toBeVisible();
}

/** Types a message and sends it with Enter. */
export async function say(page: Page, text: string): Promise<void> {
  await input(page).fill(text);
  await input(page).press('Enter');
}

/** Waits until the task names `state`. */
export async function expectState(page: Page, state: string): Promise<void> {
  await expect(pill(page)).toHaveText(t(`view.state.${state}`));
}

/** How many of the scripted model's calls were shown the text `containing`. */
export async function modelCalls(page: Page, containing: string): Promise<number> {
  const response = await page.request.get(
    `${harnessUrl()}/__e2e/model-calls?containing=${encodeURIComponent(containing)}`,
  );
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'count' in body ? Number(body.count) : -1;
}

/** A small PNG a test attaches: an orange square. */
export function sampleImage(name = 'lamp.png'): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: 'image/png', buffer: solidPng(64, [230, 120, 40]) };
}

/** Chooses files in the composer's image picker, as the attach button's dialog would. */
export async function attach(
  page: Page,
  ...files: readonly { name: string; mimeType: string; buffer: Buffer }[]
): Promise<void> {
  await page.locator('[data-slot="attach-input"]').setInputFiles([...files]);
}

/** The states the design shows, and how to reach each from a freshly opened page. */
export const STATES: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  empty: async () => {
    // A freshly opened page is the empty state.
  },
  streaming: async (page) => {
    await say(page, 'Where is my order?');
    await expectState(page, 'working');
    await expect(page.locator('[data-slot="answer"][data-streaming="true"]')).toContainText(
      'carrier',
    );
  },
  waiting: async (page) => {
    await say(page, 'Where is my order?');
    await expectState(page, 'awaiting-next-interaction');
  },
  tools: async (page) => {
    await say(page, 'Please look up order A-1041');
    await expectState(page, 'awaiting-next-interaction');
  },
  ask: async (page) => {
    await say(page, 'Please ask me how to refund');
    await expectState(page, 'awaiting-user-input');
  },
  form: async (page) => {
    await say(page, 'Show me the refund form');
    await expectState(page, 'awaiting-next-interaction');
    await expect(page.getByRole('button', { name: 'Submit refund' })).toBeVisible();
  },
  command: async (page) => {
    await say(page, '/model');
    await expect(page.locator('[data-slot="note"]')).toBeVisible();
    await input(page).fill('/effort high');
  },
  hostile: async (page) => {
    await say(page, 'Send the hostile surface');
    await expectState(page, 'awaiting-next-interaction');
  },
  attachment: async (page) => {
    await attach(page, sampleImage());
    await expect(page.locator('[data-slot="attachment"] img')).toBeVisible();
    await input(page).fill('What is this?');
  },
  image: async (page) => {
    await say(page, 'Please draw a lamp');
    await expectState(page, 'awaiting-next-interaction');
    await expect(page.locator('[data-slot="image"] img')).toBeVisible();
  },
  completed: async (page) => {
    await say(page, 'Where is my order?');
    await expectState(page, 'awaiting-next-interaction');
    await action(page, 'complete').click();
    await expectState(page, 'completed');
  },
  canceled: async (page) => {
    await say(page, 'Where is my order?');
    await expectState(page, 'awaiting-next-interaction');
    await action(page, 'cancel').click();
    await expectState(page, 'canceled');
  },
};
