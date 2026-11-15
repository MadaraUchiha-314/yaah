/**
 * The `yaah` command. Everything it does goes through the package's public API —
 * {@link loadConfig} and {@link createHarness} — so an application can do the same.
 */
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Harness } from '../kernel/bootstrap.ts';
import type { YaahConfig } from '../kernel/config-types.ts';
import { loadConfig } from '../kernel/config.ts';
import { YaahError } from '../kernel/errors.ts';
import type { CreateHarnessOptions } from '../kernel/harness.ts';
import { createHarness } from '../kernel/harness.ts';
import { t } from '../kernel/strings.ts';
import { VERSION } from '../kernel/version.ts';
import type { Invocation } from './args.ts';
import { parseArgs } from './args.ts';

/** What `yaah` knows about the harness it started. */
export interface TuiHints {
  readonly model?: string;
  readonly effort?: string;
  /** Take up the task that is already open on the harness. */
  readonly attach?: boolean;
}

/** What the command needs from the process it runs in. Tests pass their own. */
export interface CliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /**
   * Opens the terminal UI against a harness and resolves when the user leaves it. `about`
   * is what the command knows of the harness it started, for the status line.
   */
  readonly tui: (url: string, about?: TuiHints) => Promise<void>;
  /** Resolves when the process is asked to stop (Ctrl+C, SIGTERM). */
  readonly interrupted: () => Promise<void>;
  /** The user's home directory. Defaults to the real one. */
  readonly home?: string | undefined;
  /** Builds the harness. Defaults to {@link createHarness}. */
  readonly start?: ((options: CreateHarnessOptions) => Promise<Harness>) | undefined;
}

/** Exit codes: 0 done, 1 the harness could not run, 2 the command line was wrong. */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** How many ports after the configured one `yaah` tries before giving up. */
const PORT_ATTEMPTS = 20;

function isFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve: (free: boolean) => void) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, host, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * The configured port, or the next free one after it.
 *
 * @throws YaahError `cli.no-port` when none of the ports tried is free.
 */
export async function freePort(host: string, first: number): Promise<number> {
  if (first === 0) {
    return 0;
  }
  const last = Math.min(first + PORT_ATTEMPTS - 1, 65_535);
  for (let port = first; port <= last; port += 1) {
    // oxlint-disable-next-line no-await-in-loop -- ports are tried in order
    if (await isFree(host, port)) {
      return port;
    }
  }
  throw new YaahError('cli.no-port', t('cli.error.no-port', { first, last, host }));
}

function urlOf(harness: Harness, config: YaahConfig): string {
  const http = harness.ctx.get('http');
  if (http === undefined) {
    const message = t('cli.error.no-listener', { composition: config.composition });
    throw new YaahError('cli.no-listener', message);
  }
  return http.url;
}

/** `yaah`: a harness on loopback and the terminal UI against it, over HTTP like any client. */
async function chat(configPath: string | undefined, io: CliIo): Promise<void> {
  const loaded = await loadConfig({ path: configPath, home: io.home });
  if (loaded.created) {
    io.stderr.write(`${t('cli.config-created', { file: loaded.file })}\n`);
  }
  const { server, o11y } = loaded.config;
  // The terminal belongs to the UI: the log goes to a file unless the operator chose one.
  const logFile = o11y.logFile ?? join(io.home ?? homedir(), '.yaah', 'logs', 'yaah.log');
  const config: YaahConfig = {
    ...loaded.config,
    server: { ...server, port: await freePort(server.host, server.port) },
    o11y: { ...o11y, logFile },
  };
  io.stderr.write(`${t('cli.log-file', { file: logFile })}\n`);
  const harness = await (io.start ?? createHarness)({ config });
  try {
    const { llm, effort } = config.model;
    await io.tui(urlOf(harness, config), {
      model: llm,
      ...(effort === undefined ? {} : { effort }),
    });
  } finally {
    await harness.dispose();
  }
}

/** `yaah serve`: a harness serving the A2A API and the web UI until interrupted. */
async function serve(configPath: string | undefined, io: CliIo): Promise<void> {
  const loaded = await loadConfig({ path: configPath, home: io.home });
  if (loaded.created) {
    io.stderr.write(`${t('cli.config-created', { file: loaded.file })}\n`);
  }
  // The default composition is the terminal one; `serve` means the server one.
  const config: YaahConfig =
    loaded.config.composition === 'cli'
      ? { ...loaded.config, composition: 'server' }
      : loaded.config;
  const harness = await (io.start ?? createHarness)({ config });
  try {
    io.stdout.write(`${t('server.listening', { url: urlOf(harness, config) })}\n`);
    await io.interrupted();
    io.stderr.write(`${t('cli.stopping')}\n`);
  } finally {
    await harness.dispose();
  }
}

async function dispatch(invocation: Invocation, io: CliIo): Promise<number> {
  if (invocation.command === 'help') {
    io.stdout.write(`${t('cli.usage')}\n`);
  } else if (invocation.command === 'version') {
    io.stdout.write(`${VERSION}\n`);
  } else if (invocation.command === 'invalid') {
    io.stderr.write(`${t(invocation.problem, { subject: invocation.subject })}\n\n`);
    io.stderr.write(`${t('cli.usage')}\n`);
    return EXIT.usage;
  } else if (invocation.command === 'tui') {
    await io.tui(invocation.url, { attach: invocation.attach });
  } else if (invocation.command === 'serve') {
    await serve(invocation.config, io);
  } else {
    await chat(invocation.config, io);
  }
  return EXIT.ok;
}

/**
 * Runs the command and returns its exit code. A failure the harness explains — a bad
 * configuration, a plugin that did not come up — is printed as that explanation, with the
 * file, key and reason it names; anything else is a bug and is rethrown.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), io);
  } catch (error) {
    if (error instanceof YaahError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
}
