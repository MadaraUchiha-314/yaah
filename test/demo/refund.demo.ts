/**
 * The demo of the testing plan (T12), recorded: a customer asks for a refund in the web
 * chat, the agent looks things up, shows a form and asks for a decision; the decision is
 * given from the terminal chat attached to the same harness; the web chat completes the
 * task. Pictures, transcripts and the workflow history go to
 * `docs/specs/issue-3/evidence/demo/`.
 *
 * The model is real, so the script reads the screen and reacts rather than assuming the
 * exact order of the agent's moves.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { KEY, startTerminal, terminalPage } from '../e2e/terminal.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../docs/specs/issue-3/evidence/demo/', import.meta.url));
const MODE = process.env['YAAH_DEMO_DURABLE'] ?? 'temporal-remote';
const TAG = MODE === 'temporal-remote' ? 'cloud' : MODE.replace('temporal-', '');

/** The stale keys of this shell must not win over the keyring. */
function cleanEnv(): NodeJS.ProcessEnv {
  const stale = new Set(['OPENAI_API_KEY', 'TEMPORAL_API_KEY']);
  const kept = Object.entries(process.env).filter(([name]) => !stale.has(name));
  return { ...Object.fromEntries(kept), YAAH_DEMO_PORT: '7421', YAAH_DEMO_DURABLE: MODE };
}

function startHarness(): { child: ChildProcess; ready: Promise<string>; output: () => string } {
  const child = spawn('bun', ['run', 'scripts/demo/harness.ts'], { cwd: ROOT, env: cleanEnv() });
  let output = '';
  const ready = new Promise<string>((resolve, reject) => {
    const read = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const url = /^READY (\S+)$/mu.exec(output)?.[1];
      if (url !== undefined) {
        resolve(url);
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => {
      reject(new Error(`the demo harness exited with ${String(code)}:\n${output}`));
    });
  });
  return { child, ready, output: () => output };
}

const pill = (page: Page): Promise<string> => page.locator('[data-slot="state-pill"]').innerText();

/** Waits until the agent has stopped working, and returns the state in words. */
async function settled(page: Page): Promise<string> {
  await expect
    .poll(() => pill(page), { timeout: 180_000, intervals: [500] })
    .not.toMatch(/Working|Ready/u);
  await page.waitForTimeout(800);
  return pill(page);
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox').last().fill(text);
  await page.keyboard.press('Enter');
  await expect.poll(() => pill(page), { timeout: 30_000 }).toMatch(/Working/u);
}

test('the refund demo, on the web and in the terminal', async ({ page, context }) => {
  mkdirSync(OUT, { recursive: true });
  const harness = startHarness();
  const shot = (name: string): Promise<Buffer> =>
    page.screenshot({ path: `${OUT}${TAG}-${name}.png` });
  try {
    const url = await harness.ready;
    // What the operator is told at start: where the Temporal Web UI is, where yaah listens.
    const told = harness
      .output()
      .split('\n')
      .filter((line) => /Temporal Web UI|^READY|WARNING/u.test(line));
    writeFileSync(`${OUT}${TAG}-startup.txt`, `${told.join('\n')}\n`);

    // 1. The web chat starts a long-running task.
    await page.goto(url);
    await say(page, 'Order A-1041 arrived damaged. Can I get a refund?');
    await settled(page);
    await shot('01-web-first-turn');

    // 2. If the agent showed a form, fill it in and submit it.
    const form = page.locator('[data-slot="a2ui"]').last();
    if ((await form.count()) > 0) {
      const field = form.getByRole('textbox').first();
      if ((await field.count()) > 0) {
        await field.fill('The lampshade arrived cracked in two places.');
      }
      const box = form.getByRole('checkbox').first();
      if ((await box.count()) > 0) {
        await box.check();
      }
      await shot('02-web-form-filled');
      await form.getByRole('button').last().click();
      await settled(page);
    }

    // 3. The agent must come to ask for the decision; nudge it if it has not yet.
    const ask = page.locator('[data-slot="ask"]');
    for (let round = 0; round < 3; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      if ((await ask.count()) > 0) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await say(
        page,
        'The lampshade is cracked and I can send a photo. Please request the refund.',
      );
      // oxlint-disable-next-line no-await-in-loop -- as above
      await settled(page);
    }
    await expect(ask.last()).toBeVisible();
    expect(await pill(page)).toMatch(/Needs your input/u);
    await shot('03-web-asked-for-decision');
    const taskLink = await page.getByRole('link', { name: /Temporal/u }).getAttribute('href');

    // 4. The terminal chat attaches to the same harness and gives the decision.
    const screen = await context.newPage();
    await terminalPage(screen);
    const terminal = startTerminal(url, {}, '--attach');
    const attached = await terminal.screen(screen, 'Needs your input');
    expect(attached).toContain('Needs your input');
    await terminal.picture(screen, `${OUT}${TAG}-04-tui-attached.png`);
    await terminal.type('Approved. Refund the full amount.');
    await terminal.type(KEY.enter);
    const continued = await terminal.screen(screen, /Waiting for you/u);
    await terminal.picture(screen, `${OUT}${TAG}-05-tui-answered.png`);

    // 5. The web chat, which sent nothing, shows the decision and the continuation.
    await expect(page.getByText('Approved. Refund the full amount.')).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => pill(page), { timeout: 60_000 }).toMatch(/Waiting for you/u);
    await shot('06-web-sees-terminal-answer');

    // 6. A command and one more turn from the terminal.
    await terminal.type('/model');
    await terminal.type(KEY.enter);
    await terminal.screen(screen, 'Model:');
    await terminal.type('Thanks. When will the money arrive?');
    await terminal.type(KEY.enter);
    await screen.waitForTimeout(1500);
    const last = await terminal.screen(screen, /Waiting for you/u);
    await terminal.picture(screen, `${OUT}${TAG}-07-tui-command-and-turn.png`);

    // 7. The web chat completes the task; both show it completed.
    await expect.poll(() => pill(page), { timeout: 60_000 }).toMatch(/Waiting for you/u);
    await page.getByRole('button', { name: 'Complete task' }).click();
    await expect.poll(() => pill(page), { timeout: 30_000 }).toMatch(/Completed/u);
    await shot('08-web-completed');
    const done = await terminal.screen(screen, 'Completed');
    expect(done).toContain('Completed');
    await terminal.picture(screen, `${OUT}${TAG}-09-tui-completed.png`);
    terminal.kill();

    // 8. The workflow behind the task.
    const taskId = /yaah-([0-9a-f-]{36})/u.exec(taskLink ?? '')?.[1] ?? '';
    const history = spawnSync('bun', ['run', 'scripts/demo/history.ts', taskId], {
      cwd: ROOT,
      env: cleanEnv(),
      encoding: 'utf8',
    });
    writeFileSync(
      `${OUT}${TAG}-transcript.md`,
      [
        `# Demo transcript (${MODE})`,
        '',
        `Workflow link shown by the web chat: ${taskLink ?? '(none)'}`,
        '',
        '## Web chat, at the end',
        '',
        '```text',
        await page.locator('[role="log"]').innerText(),
        '```',
        '',
        '## Terminal chat: on attaching, after answering, after the last turn',
        '',
        '```text',
        attached.trimEnd(),
        '',
        continued.trimEnd(),
        '',
        last.trimEnd(),
        '```',
        '',
        '## Workflow history',
        '',
        '```text',
        (history.stdout + history.stderr).trimEnd(),
        '```',
        '',
      ].join('\n'),
    );
    if (MODE === 'temporal-embedded' && taskLink !== null) {
      await page.goto(taskLink);
      await page.waitForTimeout(4000);
      await shot('10-temporal-web-ui');
    }
  } finally {
    harness.child.kill('SIGTERM');
  }
});
