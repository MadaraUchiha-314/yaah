/**
 * Runs the terminal chat on a real pseudo-terminal and reads its screen the way a person
 * would see it: the raw output is replayed into xterm.js in the browser page, which gives
 * both the text of the screen and a picture of it.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const XTERM = fileURLToPath(new URL('../../node_modules/@xterm/xterm/', import.meta.url));

export const COLUMNS = 96;
export const ROWS = 30;

/** Keys the tests press. */
export const KEY = { enter: '\r', tab: '\t', ctrlD: '\u0004', ctrlX: '\u0018', space: ' ' };

/** A terminal chat running on a pty. */
export interface Terminal {
  /**
   * Types text or presses one key, then waits a moment: a terminal reads what arrives
   * together as one keypress, and a person's keys arrive apart.
   */
  type(keys: string): Promise<void>;
  /** The screen as text, once it shows `expected`. */
  screen(page: Page, expected: string | RegExp): Promise<string>;
  /** Saves a picture of the screen as it is now. */
  picture(page: Page, path: string): Promise<void>;
  /** Resolves with the exit code once the chat has left. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

async function render(page: Page, output: string): Promise<string> {
  const call = `renderTerminal(${JSON.stringify(output)}, ${String(COLUMNS)}, ${String(ROWS)})`;
  const screen: unknown = await page.evaluate(call);
  return typeof screen === 'string' ? screen : '';
}

/** Prepares `page` to draw terminal screens. */
export async function terminalPage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.setContent(
    '<body style="margin:0;background:#0b0b0c"><div id="terminal"></div></body>',
  );
  await page.addStyleTag({ path: `${XTERM}css/xterm.css` });
  await page.addScriptTag({ path: `${XTERM}lib/xterm.js` });
  await page.addScriptTag({ path: fileURLToPath(new URL('terminal-page.js', import.meta.url)) });
}

/** Starts `yaah tui --url <url>` from source on a pseudo-terminal of a fixed size. */
export function startTerminal(
  url: string,
  env: Readonly<Record<string, string>> = {},
  flags = '',
): Terminal {
  const command = `stty cols ${String(COLUMNS)} rows ${String(ROWS)}; exec bun src/cli/bin.ts tui --url ${url} ${flags}`;
  const child: ChildProcessWithoutNullStreams = spawn('script', ['-qfec', command, '/dev/null'], {
    cwd: ROOT,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '3', ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
  });
  return {
    exited,
    type: async (keys: string): Promise<void> => {
      child.stdin.write(keys);
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
    },
    kill: (): void => {
      child.kill('SIGKILL');
    },
    picture: async (page: Page, path: string): Promise<void> => {
      await render(page, output);
      await page.locator('#terminal').screenshot({ path });
    },
    screen: async (page: Page, expected: string | RegExp): Promise<string> => {
      const matches = (text: string): boolean =>
        typeof expected === 'string' ? text.includes(expected) : expected.test(text);
      const deadline = Date.now() + 15_000;
      let text = '';
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- polling the screen
        text = await render(page, output);
        if (matches(text) || Date.now() > deadline) {
          return text;
        }
        // oxlint-disable-next-line no-await-in-loop -- as above
        await page.waitForTimeout(150);
      }
    },
  };
}
