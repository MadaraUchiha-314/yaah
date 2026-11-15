/**
 * The terminal UI: a surface that reaches a harness from a terminal, and the renderer
 * it draws with. On a terminal it is an Ink application; without one (piped output, or
 * `NO_COLOR`) it prints plain lines.
 */
import { render } from 'ink';
import { createElement } from 'react';

import { LOCAL } from '../../../kernel/entity.ts';
import { YaahError } from '../../../kernel/errors.ts';
import { t } from '../../../kernel/strings.ts';
import { HarnessSession } from '../../session.ts';
import type { Renderer, Surface } from '../../types.ts';
import { BASIC_CATALOG_ID } from './a2ui-model.ts';
import { App } from './app.tsx';
import { TuiController } from './controller.ts';
import { sanitize } from './filter.ts';
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
  /** Take up the task that is already open on the harness instead of starting fresh. */
  readonly attach?: boolean;
  /** The model in use, shown in the status line when given. */
  readonly model?: string;
  /** The reasoning effort in use, shown in the status line when given. */
  readonly effort?: string;
  /** Leaves the interface, as `/exit` does, when it aborts. */
  readonly signal?: AbortSignal | undefined;
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
 * Connects to the harness the terminal UI is for.
 *
 * @throws YaahError `tui.connect` when it cannot be reached or does not answer with an
 * agent card. The message is one line, filtered: the reason can come from the server.
 */
async function connect(url: string): Promise<HarnessSession> {
  try {
    return await HarnessSession.connect(url, {
      a2uiCatalogs: [BASIC_CATALOG_ID],
      longRunning: true,
    });
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    const reason = sanitize(said).replaceAll(/\s+/gu, ' ').trim();
    const message = t('tui.error.connect', { url: sanitize(url), reason });
    throw new YaahError('tui.connect', message, error);
  }
}

/**
 * Opens the terminal UI against the harness at `options.url` and resolves when the
 * user leaves (`/exit`, Ctrl+C, or the end of piped input). By then Ink has unmounted
 * and given the terminal back as it found it.
 *
 * @throws YaahError `tui.connect` when the harness cannot be reached.
 */
export async function runTui(options: TuiOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const session = await connect(options.url);
  const controller = new TuiController(session);
  controller.attach(session, options.attach === true);
  const leave = (): void => {
    controller.exit();
  };
  options.signal?.addEventListener('abort', leave, { once: true });
  if (options.signal?.aborted === true) {
    leave();
  }
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
    // Where the terminal speaks the kitty keyboard protocol, keys report their release,
    // which is what lets Space be held to talk. Elsewhere this changes nothing.
    kittyKeyboard: {
      mode: 'auto',
      flags: [
        'disambiguateEscapeCodes',
        'reportEventTypes',
        'reportAllKeysAsEscapeCodes',
        'reportAssociatedText',
      ],
    },
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
    modalities: ['text', 'audio'],
    renderer: tuiRenderer,
    open: async (url: string): Promise<void> => {
      await runTui({ ...options, url });
    },
  };
}

/** The surface entity of the terminal UI, on the process's own terminal. */
export const tuiSurface: Surface = createTuiSurface();
