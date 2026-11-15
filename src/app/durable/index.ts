/**
 * The durable-execution plugin. Provides the `durable` service in the mode the
 * configuration names. Mode `none` runs task loops in this process over a journal.
 */
import type { Context } from 'cordis';

import type { EntityRegistry } from '../../kernel/registry.ts';
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

/**
 * Whether a step may be attempted again. Every step is — each writes under its own key
 * and replaces on retry — except a call to a tool that did not declare itself safe.
 */
export function isRetrySafe(registry: EntityRegistry, step: string, input: unknown): boolean {
  if (step !== 'tool.invoke') {
    return true;
  }
  const fields: Readonly<Record<string, unknown>> =
    typeof input === 'object' && input !== null ? { ...input } : {};
  const call: Readonly<Record<string, unknown>> =
    typeof fields['call'] === 'object' && fields['call'] !== null ? { ...fields['call'] } : {};
  const id = typeof call['name'] === 'string' ? call['name'] : '';
  const ref = { kind: 'tool', id, version: null } as const;
  // A tool that is not registered is refused without being run: repeating that is harmless.
  return !registry.has(ref) || registry.resolve(ref).retrySafe;
}

export const name = 'durable';
export const inject: readonly string[] = [
  'config',
  'entities',
  'taskRuntime',
  'persistence',
  'strings',
  'redactor',
];

/** Starts the configured durable mode. */
export async function apply(ctx: Context): Promise<void> {
  const safe = (step: string, input: unknown): boolean => isRetrySafe(ctx.entities, step, input);
  const durable: DurableExecution =
    ctx.config.durable.mode === 'none'
      ? new InProcessDurable({
          handlers: ctx.taskRuntime.handlers,
          limits: ctx.taskRuntime.limits,
          journal: ctx.persistence.journal,
          retry: ctx.config.durable.retry,
          isRetrySafe: safe,
          onError: (taskId: string, error: unknown): void => {
            ctx.emit('durable/run-error', taskId, error);
          },
        })
      : await (await import('./temporal/index.ts')).startTemporal(ctx, safe);
  const dashboard = durable.dashboard();
  if (dashboard !== null) {
    // The address is shown every time the harness starts with Temporal.
    process.stderr.write(`${ctx.strings.t('durable.dashboard', { url: dashboard.url })}\n`);
  }
  ctx.effect(() => {
    const release = ctx.provide('durable', durable);
    return async (): Promise<void> => {
      release();
      await durable.close();
    };
  });
}
