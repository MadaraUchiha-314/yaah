/**
 * The browser build, end to end: `dist/browser/` served by a plain static file server —
 * no yaah process anywhere — with the harness running in the tab and the model an
 * OpenAI-compatible endpoint answered by the test.
 */
import { fileURLToPath } from 'node:url';

import type { Page, Request, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { t } from '../../src/kernel/strings.ts';
import type { StaticServer } from './static-server.ts';
import { serveStatic } from './static-server.ts';

const SITE = fileURLToPath(new URL('../../dist/browser', import.meta.url));
const MODEL_PATH = '/v1/chat/completions';
const EVIDENCE = fileURLToPath(new URL('../../docs/specs/issue-3/evidence/ui/', import.meta.url));

let site: StaticServer | undefined = undefined;

test.beforeEach(async () => {
  site = await serveStatic(SITE);
});

test.afterEach(async () => {
  await site?.stop();
});

function origin(): string {
  return site?.url ?? '';
}

/** A configuration naming an OpenAI-compatible endpoint under the site's own origin. */
function config(extra = ''): string {
  return [
    'model = { llm = "proxy/test-model" }',
    '[[providers.compatible]]',
    'id = "proxy"',
    `base_url = "${origin()}/v1"`,
    'models = ["test-model"]',
    extra,
  ].join('\n');
}

const chunk = (delta: object, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1_794_700_000,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: null,
  })}\n\n`;

/** A streamed answer in the Chat Completions dialect, word by word. */
function sayStream(text: string): string {
  const words = text.match(/\S+\s*/gu) ?? [];
  return [
    chunk({ role: 'assistant', content: '' }),
    ...words.map((word) => chunk({ content: word })),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('');
}

/** A streamed call of one tool. */
function callStream(name: string, args: object): string {
  const call = { index: 0, id: 'call_e2e', type: 'function' };
  return [
    chunk({ role: 'assistant', content: null }),
    chunk({ tool_calls: [{ ...call, function: { name, arguments: JSON.stringify(args) } }] }),
    chunk({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ].join('');
}

/** What the stand-in model answers, from the request alone. */
function answer(body: string): string {
  const parsed: unknown = JSON.parse(body);
  const messages: unknown[] =
    typeof parsed === 'object' && parsed !== null && 'messages' in parsed
      ? [parsed.messages].flat()
      : [];
  const last = JSON.stringify(messages.at(-1));
  if (last.includes('"role":"tool"')) {
    return sayStream('The refund is filed. Anything else?');
  }
  if (last.includes('ask me')) {
    return callStream('ask_user', { question: 'Refund or store credit?' });
  }
  return sayStream('It reaches your account within three working days.');
}

interface Traffic {
  /** Every request the page made, as `METHOD path`. */
  readonly made: string[];
  /** The model requests the test answered. */
  readonly model: Request[];
}

/** Answers the configuration and the model, and records everything the page requests. */
async function wire(page: Page, toml: string): Promise<Traffic> {
  const traffic: Traffic = { made: [], model: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    traffic.made.push(
      `${request.method()} ${url.origin === origin() ? '' : url.origin}${url.pathname}`,
    );
  });
  await page.route('**/config.toml', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/toml', body: toml }),
  );
  await page.route(`**${MODEL_PATH}`, async (route: Route) => {
    traffic.model.push(route.request());
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: answer(route.request().postData() ?? '{}'),
    });
  });
  return traffic;
}

const input = (page: Page) => page.getByRole('textbox', { name: t('web.input.label') });
const pill = (page: Page) => page.locator('[data-slot="state-pill"]');

async function say(page: Page, text: string): Promise<void> {
  await input(page).fill(text);
  await input(page).press('Enter');
}

async function expectState(page: Page, state: string): Promise<void> {
  await expect(pill(page)).toHaveText(t(`view.state.${state}`));
}

/**
 * Feature: Browser build
 * Scenario: The browser build completes a multi-turn task without a server
 *   Given dist/browser served as static files, and a configured OpenAI-compatible model
 *   When the user sends a message, is asked a question, answers it, sends a second
 *        message in the same task, and completes the task
 *   Then every turn is answered by the harness in the tab, the task ends completed,
 *   And the only requests that left the page are for the site's static files and the model
 * Requirement: docs/specs/issue-3/requirements.md R25.1, R25.2
 */
test('The browser build completes a multi-turn task without a server', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const traffic = await wire(page, config());
  await page.goto(origin());
  await expect(input(page)).toBeVisible();

  await say(page, 'My lamp arrived broken. Please ask me what I want.');
  await expectState(page, 'awaiting-user-input');
  await expect(page.getByText('Refund or store credit?')).toBeVisible();

  await say(page, 'A refund, please.');
  await expectState(page, 'awaiting-next-interaction');
  await expect(page.getByText('The refund is filed. Anything else?')).toBeVisible();

  await say(page, 'When will I have the money?');
  await expect(page.getByText('It reaches your account within three working days.')).toBeVisible();
  await expectState(page, 'awaiting-next-interaction');

  await page.getByRole('button', { name: t('view.action.complete') }).click();
  await expectState(page, 'completed');

  if (process.env['YAAH_UPDATE_EVIDENCE'] !== undefined) {
    // The picture kept as evidence: `YAAH_UPDATE_EVIDENCE=1 bun run test:e2e`.
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${EVIDENCE}browser-completed-light.png` });
  }

  // Three model calls, one conversation: the last was shown the earlier turns.
  expect(traffic.model.length).toBe(3);
  const shown = traffic.model.at(-1)?.postData() ?? '';
  expect(shown).toContain('My lamp arrived broken');
  expect(shown).toContain('The refund is filed');
  // No credential was configured, so none is sent.
  expect(await traffic.model[0]?.headerValue('authorization')).toBeNull();

  // Nothing but the site's own files and the model: no A2A call ever left the tab.
  const others = traffic.made.filter(
    (request) =>
      request !== 'GET /' &&
      request !== 'GET /config.toml' &&
      !/^GET \/assets\/[\w.-]+\.(?:js|css)$/u.test(request) &&
      request !== `POST ${MODEL_PATH}`,
  );
  expect(others).toEqual([]);
  // And the server behind the page only ever handed out files it has.
  const served = site?.requests ?? [];
  expect(served.length).toBeGreaterThan(1);
  expect(served.filter((request) => request.method !== 'GET' || request.status !== 200)).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});

/**
 * Feature: Browser build
 * Scenario: A credential given to the page reaches the model it is configured for
 *   Given a configuration whose endpoint names a key by variable, and a page that was
 *         handed that key
 *   When the user sends a message
 *   Then the model request carries the key
 * Requirement: docs/specs/issue-3/requirements.md R25.2
 */
test('A credential given to the page reaches the model it is configured for', async ({ page }) => {
  const traffic = await wire(page, '');
  const toml = config().replace('models =', 'api_key_env = "PROXY_KEY"\nmodels =');
  await page.addInitScript(
    (options) => {
      Reflect.set(globalThis, 'yaah', options);
    },
    { config: toml, credentials: { PROXY_KEY: 'sk-e2e-developer-key' } },
  );
  await page.goto(origin());
  await say(page, 'When will I have the money?');
  await expectState(page, 'awaiting-next-interaction');
  expect(await traffic.model[0]?.headerValue('authorization')).toBe('Bearer sk-e2e-developer-key');
  expect(traffic.made).not.toContain('GET /config.toml');
});

/**
 * Feature: Browser build
 * Scenario: A page with no usable model says why
 *   Given the configuration shipped with the build, which names no endpoint and no key
 *   When the page is opened
 *   Then it reports the missing credential instead of a chat that cannot answer
 * Requirement: docs/specs/issue-3/requirements.md R25.2
 */
test('A page with no usable model says why', async ({ page }) => {
  await page.goto(origin());
  await expect(page.getByRole('alert')).toContainText('OPENAI_API_KEY');
});
