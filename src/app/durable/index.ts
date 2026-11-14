/**
 * The durable-execution plugin. Provides the `durable` service in the mode the
 * configuration names. Mode `none` runs task loops in this process over a journal.
 */
import type { Context } from 'cordis';

import { YaahError } from '../../kernel/errors.ts';
import { InProcessDurable } from './in-process.ts';
import type { DurableExecution } from './types.ts';

export type { DurableExecution } from './types.ts';

declare module 'cordis' {
  interface Context {
    /** Runs task loops. Replace by providing this service from another plugin. */
    durable: DurableExecution;
  }
  interface Events {
    /** A task's run ended with an error the loop could not record. */
    'durable/run-error'(taskId: string, error: unknown): void;
  }
}

export const name = 'durable';
export const inject: readonly string[] = ['config', 'taskRuntime', 'persistence', 'strings'];

/** Starts the configured durable mode. */
export function apply(ctx: Context): void {
  const { mode } = ctx.config.durable;
  if (mode !== 'none') {
    throw new YaahError(
      'durable.unavailable',
      ctx.strings.t('error.durable.unavailable', { mode }),
    );
  }
  const durable = new InProcessDurable({
    handlers: ctx.taskRuntime.handlers,
    limits: ctx.taskRuntime.limits,
    journal: ctx.persistence.journal,
    onError: (taskId: string, error: unknown): void => {
      ctx.emit('durable/run-error', taskId, error);
    },
  });
  ctx.effect(() => {
    const release = ctx.provide('durable', durable);
    return async (): Promise<void> => {
      release();
      await durable.close();
    };
  });
}
