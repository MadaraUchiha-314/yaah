/**
 * Helpers for testing the terminal UI: rendering a view to the text a person would
 * read, fake terminal streams, and waiting for the screen to show something.
 */
import { PassThrough, Writable } from 'node:stream';

import { renderToString } from 'ink';
import { createElement } from 'react';

import { A2uiModel } from '../../src/surface/renderer/tui/a2ui-model.ts';
import type { ScreenProps } from '../../src/surface/renderer/tui/components.tsx';
import { Screen } from '../../src/surface/renderer/tui/components.tsx';
import type { TaskView } from '../../src/surface/view.ts';

/** Removes colour and style codes (SGR) — and nothing else — from terminal output. */
export function stripColour(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching the escape character is the point
  return text.replaceAll(/\u001B\[[0-9;]*m/gu, '');
}

/** Draws the whole screen for a view and returns its visible text. */
export function renderToText(view: TaskView, props: Partial<ScreenProps> = {}): string {
  const screen = createElement(Screen, {
    view,
    busy: false,
    models: (_itemId, batches) => {
      const model = new A2uiModel();
      model.apply(batches);
      return model;
    },
    focus: null,
    text: '',
    focused: true,
    commands: [],
    state: view.state,
    dashboardUrl: null,
    ...props,
  });
  return stripColour(renderToString(screen, { columns: 100 }));
}

/** A keyboard: a readable stream that says it is a terminal and records raw-mode changes. */
export class FakeKeyboard extends PassThrough {
  readonly isTTY: boolean = true;
  /** Every `setRawMode` call, in order. Ends with `false` once the terminal is restored. */
  readonly rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
}

/** A display: a writable stream that keeps everything written to it. */
export class FakeDisplay extends Writable {
  readonly isTTY: boolean;
  readonly columns: number = 100;
  readonly rows: number = 50;
  #written = '';

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  /** Everything written so far, escape codes included. */
  get raw(): string {
    return this.#written;
  }

  /** Everything written so far, without colour codes. */
  get text(): string {
    return stripColour(this.#written);
  }

  override _write(chunk: unknown, _encoding: string, done: () => void): void {
    this.#written += String(chunk);
    done();
  }
}

const POLL_MS = 5;

/** Resolves once `ready()` is true; fails with `describe()` after `timeoutMs`. */
export async function waitFor(
  ready: () => boolean,
  describe: () => string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; last seen:\n${describe()}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** Key sequences as a terminal sends them. */
export const KEY = {
  enter: '\r',
  tab: '\t',
  space: ' ',
  backspace: '\u007F',
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  shiftTab: '\u001B[Z',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlO: '\u000F',
  ctrlX: '\u0018',
} as const;
