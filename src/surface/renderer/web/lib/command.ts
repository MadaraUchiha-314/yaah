/**
 * Commands in what the user types: whether the first word is one the harness lists, and
 * what the composer says about it.
 */
import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';

/** How the composer reads the text typed so far. */
export interface CommandReading {
  /** The matched command with its slash, or null when the first word is not a command. */
  readonly command: string | null;
  /** What to tell the user below the input; empty when the text is not a command attempt. */
  readonly hint: string;
}

/** A command's name as typed: with one leading slash, however the harness lists it. */
function typed(name: string): string {
  return name.startsWith('/') ? name : `/${name}`;
}

/** The first word of `text` and what follows it. */
export function splitCommand(text: string): { readonly first: string; readonly rest: string } {
  const first = /^\S*/u.exec(text)?.[0] ?? '';
  return { first, rest: text.slice(first.length) };
}

/** Reads `text` against the commands the harness lists. */
export function readCommand(text: string, commands: readonly CommandInfo[]): CommandReading {
  const { first } = splitCommand(text);
  if (!first.startsWith('/')) {
    return { command: null, hint: '' };
  }
  const names = commands.map((command) => typed(command.name));
  return names.includes(first)
    ? { command: first, hint: t('view.command.hint', { name: first }) }
    : { command: null, hint: t('view.command.list', { names: names.join('  ') }) };
}

/** Whether the harness lists a command called `name` (given without its slash). */
export function hasCommand(commands: readonly CommandInfo[], name: string): boolean {
  return commands.some((command) => typed(command.name) === `/${name}`);
}
