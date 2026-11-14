/**
 * The terminal UI: a surface that reaches a harness from a terminal, and the renderer
 * it draws with. On a terminal it is an Ink application; without one (piped output, or
 * `NO_COLOR`) it prints plain lines.
 */
import { render } from 'ink';
import { createElement } from 'react';

import { LOCAL } from '../../../kernel/entity.ts';
import { t } from '../../../kernel/strings.ts';
import { HarnessSession } from '../../session.ts';
import type { Renderer, Surface } from '../../types.ts';
import { BASIC_CATALOG_ID } from './a2ui-model.ts';
import { App } from './app.tsx';
import { TuiController } from './controller.ts';
import { runPlain } from './plain.ts';

export { sanitize } from './filter.ts';
export { BASIC_CATALOG_ID } from './a2ui-model.ts';

/** Options of {@link runTui}. */
export interface TuiOptions {
  /** The address of the harness's A2A endpoint. */
  readonly url: string;
  /** Where keys or lines are read from. Defaults to `process.stdin`. */
  readonly stdin?: NodeJS.ReadableStream;
  /** Where the interface is drawn or printed. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** The environment `NO_COLOR` is read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The model in use, shown in the status line when given. */
  readonly model?: string;
  /** The reasoning effort in use, shown in the status line when given. */
  readonly effort?: string;
}

/**
 * Whether the interface must fall back to plain lines: output is not a terminal, or
 * the user declined colour with a non-empty `NO_COLOR`.
 */
export function isPlain(
  stdout: NodeJS.WritableStream,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const tty = 'isTTY' in stdout && stdout.isTTY === true;
  return !tty || (env['NO_COLOR'] ?? '') !== '';
}

/**
 * Opens the terminal UI against the harness at `options.url` and resolves when the
 * user leaves (`/exit`, Ctrl+C, or the end of piped input). By then Ink has unmounted
 * and given the terminal back as it found it.
 */
export async function runTui(options: TuiOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const session = await HarnessSession.connect(options.url, {
    a2uiCatalogs: [BASIC_CATALOG_ID],
    longRunning: true,
  });
  const controller = new TuiController(session);
  if (isPlain(stdout, options.env ?? process.env)) {
    await runPlain(controller, stdin, stdout);
    return;
  }
  const app = createElement(App, {
    controller,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
  const instance = render(app, {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    controller.exit();
    instance.unmount();
  }
}

/** The renderer entity of the terminal UI: Ink, with the A2UI basic catalog. */
export const tuiRenderer: Renderer = {
  ref: { kind: 'renderer', id: 'tui', version: null },
  description: t('renderer.tui.description'),
  locality: LOCAL,
  a2uiCatalogs: [BASIC_CATALOG_ID],
};

/**
 * Builds the surface entity of the terminal UI. Opening it runs {@link runTui} with
 * `options` — streams and environment other than the process's own, when given.
 */
export function createTuiSurface(options: Omit<TuiOptions, 'url'> = {}): Surface {
  return {
    ref: { kind: 'surface', id: 'tui', version: null },
    description: t('surface.tui.description'),
    locality: LOCAL,
    modalities: ['text'],
    renderer: tuiRenderer,
    open: async (url: string): Promise<void> => {
      await runTui({ ...options, url });
    },
  };
}

/** The surface entity of the terminal UI, on the process's own terminal. */
export const tuiSurface: Surface = createTuiSurface();
