/**
 * The commands plugin: `/model`, `/effort`, `/exit`, a registry for commands other
 * plugins add, and the dispatcher that answers a command before the message can reach
 * the inbox — and so before it can reach a model. Provides the `commands` service.
 */
import type { Message } from '@a2a-js/sdk';
import type { RequestContext } from '@a2a-js/sdk/server';
import type { Context } from 'cordis';

import { agentMessage, messageText, partsToA2a } from '../../app/api-server/convert.ts';
import type { CommandInfo, CommandOutcome } from '../../app/api-server/extensions/index.ts';
import { EXT } from '../../app/api-server/extensions/index.ts';
import type { TaskSettings } from '../../app/api-server/task-port.ts';
import { readSettings } from '../../app/api-server/task-port.ts';
import { YaahError } from '../../kernel/errors.ts';
import type { LLM } from '../models/llm/types.ts';
import type { Command, CommandContext, CommandFunction } from './types.ts';
import { defineCommand, parseCommand } from './types.ts';

export { defineCommand, parseCommand } from './types.ts';
export type { Command, CommandContext, CommandFunction, CommandResult } from './types.ts';

/** The commands service. */
export interface CommandsService {
  /**
   * Registers a command as a name and a function. It is removed when the function this
   * returns is called, or at the latest when the commands plugin is disposed.
   */
  register(name: string, run: CommandFunction, description?: string): () => void;
}

declare module 'cordis' {
  interface Context {
    /** Slash commands. */
    commands: CommandsService;
  }
  interface Events {
    /** A command was recognised and is about to run. */
    'command/invoked'(name: string, args: string): void;
    /** A command ran. */
    'command/executed'(name: string): void;
    /** A command threw. */
    'command/failed'(name: string, error: unknown): void;
  }
}

export const name = 'commands';
export const inject: readonly string[] = ['entities', 'config', 'strings', 'taskRuntime', 'a2a'];

/** A command refused what it was given. The message is shown to the user. */
class CommandError extends YaahError {
  constructor(message: string) {
    super('command.rejected', message);
  }
}

interface Selection {
  llm?: string;
  effort?: string;
}

/** Builds the `/model` and `/effort` commands over the per-conversation selection. */
function selectionCommands(ctx: Context, selections: Map<string, Selection>): Command[] {
  const { strings, entities, config } = ctx;
  const models = (): string[] => entities.list('llm').map((llm: LLM) => llm.ref.id);
  const current = (where: CommandContext): Required<Selection> => {
    const task = where.taskId === null ? undefined : ctx.taskRuntime.taskStore.get(where.taskId);
    const settings = task === undefined ? undefined : readSettings(task);
    const chosen = selections.get(where.contextId);
    return {
      llm: settings?.llm ?? chosen?.llm ?? config.model.llm,
      effort: settings?.effort ?? chosen?.effort ?? config.model.effort,
    };
  };
  const select = (where: CommandContext, change: Selection): void => {
    selections.set(where.contextId, { ...selections.get(where.contextId), ...change });
    if (where.taskId !== null) {
      ctx.taskRuntime.tasks.updateSettings(where.taskId, change);
    }
  };
  const model = defineCommand({
    name: 'model',
    description: strings.t('command.model.description'),
    run: (args: string, where: CommandContext) => {
      const available = models().join(', ');
      if (args === '') {
        const text = strings.t('command.model.current', { current: current(where).llm, available });
        return Promise.resolve({ text });
      }
      if (!models().includes(args)) {
        throw new CommandError(strings.t('command.model.unknown', { id: args, available }));
      }
      select(where, { llm: args });
      return Promise.resolve({ text: strings.t('command.model.set', { id: args }) });
    },
  });
  const effort = defineCommand({
    name: 'effort',
    description: strings.t('command.effort.description'),
    run: (args: string, where: CommandContext) => {
      const selected = current(where);
      const llm = entities.resolve({ kind: 'llm', id: selected.llm, version: null });
      const levels = llm.capabilities.efforts.join(', ');
      const params = { model: selected.llm, levels };
      if (args === '') {
        const text = strings.t('command.effort.current', { ...params, current: selected.effort });
        return Promise.resolve({ text });
      }
      if (!llm.capabilities.efforts.includes(args)) {
        throw new CommandError(strings.t('command.effort.unknown', { ...params, level: args }));
      }
      select(where, { effort: args });
      return Promise.resolve({ text: strings.t('command.effort.set', { level: args }) });
    },
  });
  return [model, effort];
}

/** Runs one parsed command and reports what happened. */
async function run(
  ctx: Context,
  parsed: { name: string; args: string },
  where: CommandContext,
): Promise<{ text: string; status: CommandOutcome['status']; prompt?: string | undefined }> {
  const { strings, entities } = ctx;
  const ref = { kind: 'command', id: parsed.name, version: null } as const;
  if (!entities.has(ref)) {
    const known = entities
      .list('command')
      .map((command: Command) => `/${command.name}`)
      .join(', ');
    return { text: strings.t('command.unknown', { name: parsed.name, known }), status: 'unknown' };
  }
  const command = entities.resolve(ref);
  if (command.scope === 'surface') {
    return { text: strings.t('command.surface', { name: parsed.name }), status: 'executed' };
  }
  ctx.emit('command/invoked', parsed.name, parsed.args);
  try {
    const result = await command.run(parsed.args, where);
    ctx.emit('command/executed', parsed.name);
    return { text: result.text, status: 'executed', prompt: result.prompt };
  } catch (error) {
    ctx.emit('command/failed', parsed.name, error);
    const reason = error instanceof Error ? error.message : String(error);
    const text =
      error instanceof CommandError
        ? reason
        : strings.t('command.failed', { name: parsed.name, reason });
    return { text, status: 'failed' };
  }
}

/** Starts the commands plugin. */
export function apply(ctx: Context): void {
  const selections = new Map<string, Selection>();
  const register = (command: Command): (() => void) => {
    const dispose = ctx.effect(() => ctx.entities.register(command));
    return (): void => {
      void dispose();
    };
  };
  for (const command of selectionCommands(ctx, selections)) {
    register(command);
  }
  register(
    defineCommand({
      name: 'exit',
      description: ctx.strings.t('command.exit.description'),
      scope: 'surface',
      run: () => Promise.resolve({ text: '' }),
    }),
  );
  ctx.provide('commands', {
    register: (commandName: string, fn: CommandFunction, description = ''): (() => void) =>
      register(defineCommand({ name: commandName, description, run: fn })),
  });
  const dispatch = async (request: RequestContext): Promise<Message | null> => {
    const parsed = parseCommand(messageText(request.userMessage));
    if (parsed === null) {
      return null;
    }
    const taskId = request.task === undefined ? null : request.taskId;
    const outcome = await run(ctx, parsed, { taskId, contextId: request.contextId });
    if (outcome.prompt !== undefined) {
      // A prompt command: the turn goes on, with the prompt as what the user said.
      request.userMessage.parts = partsToA2a([{ type: 'text', text: outcome.prompt }]);
      return null;
    }
    const data: CommandOutcome = { command: parsed.name, status: outcome.status };
    return agentMessage({
      messageId: `command-${request.userMessage.messageId}`,
      taskId: taskId ?? '',
      contextId: request.contextId,
      parts: [{ type: 'text', text: outcome.text }],
      metadata: { [EXT.commands]: { ...data } },
      extensions: [EXT.commands],
    });
  };
  const list = (): CommandInfo[] =>
    ctx.entities.list('command').map((command: Command) => ({
      name: command.name,
      description: command.description,
      scope: command.scope,
    }));
  ctx.effect(() => ctx.a2a.setCommands(dispatch, list));
  ctx.effect(() =>
    ctx.a2a.setContextSettings((contextId: string): Partial<TaskSettings> => {
      const chosen = selections.get(contextId);
      return { llm: chosen?.llm ?? null, effort: chosen?.effort ?? null };
    }),
  );
}
