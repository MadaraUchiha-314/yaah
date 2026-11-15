#!/usr/bin/env node
/** The `yaah` executable: the command wired to this process and the terminal UI. */
import { runTui } from '../surface/renderer/tui/index.ts';
import { runCli } from './main.ts';

function interrupted(): Promise<void> {
  return new Promise((resolve: () => void) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  interrupted,
  tui: (url: string, about: { readonly model?: string; readonly effort?: string } = {}) =>
    runTui({ url, ...about }),
});
