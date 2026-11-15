#!/usr/bin/env node
/** The `yaah` executable: the command wired to this process and the terminal UI. */
import { runTui } from '../surface/renderer/tui/index.ts';
import type { TuiHints } from './main.ts';
import { runCli } from './main.ts';
import { interrupted } from './signals.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  interrupted,
  tui: (url: string, about: TuiHints = {}, signal?: AbortSignal) =>
    runTui({ url, ...about, signal }),
});
