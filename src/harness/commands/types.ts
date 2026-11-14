/**
 * Commands: things a user types that are not conversation — `/model`, `/effort`, and
 * whatever plugins add. A command is an entity like any other.
 */
import type { Entity } from '../../kernel/entity.ts';
import { LOCAL } from '../../kernel/entity.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    command: Command;
  }
}

/** What a command is told about where it was invoked. */
export interface CommandContext {
  /** The task the command was typed on, or null when it was typed before any task. */
  readonly taskId: string | null;
  /** The conversation the command was typed in. */
  readonly contextId: string;
}

/** What a command answers. Thrown errors are reported to the user as a failure. */
export interface CommandResult {
  /** Shown to the user. */
  readonly text: string;
}

/** The function behind a command. */
export type CommandFunction = (args: string, ctx: CommandContext) => Promise<CommandResult>;

/** A slash command. */
export interface Command extends Entity<'command'> {
  /** The name typed after the slash. Equal to the entity id. */
  readonly name: string;
  /**
   * Who runs it. A `surface` command (such as `/exit`) is carried out by the interface
   * the user is in; the harness only lists it, so that every interface highlights it.
   */
  readonly scope: 'harness' | 'surface';
  readonly run: CommandFunction;
}

/** What {@link defineCommand} needs. */
export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly scope?: 'harness' | 'surface';
  readonly run: CommandFunction;
}

/** Builds a command entity. */
export function defineCommand(definition: CommandDefinition): Command {
  return {
    ref: { kind: 'command', id: definition.name, version: null },
    description: definition.description,
    locality: LOCAL,
    name: definition.name,
    scope: definition.scope ?? 'harness',
    run: definition.run,
  };
}

/** Splits `/name rest of line` into the name and its arguments, or null if it is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) {
    return null;
  }
  return { name: match[1] ?? '', args: (match[2] ?? '').trim() };
}
