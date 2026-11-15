/**
 * Starts the Temporal durable mode the configuration names. Loaded only when a Temporal
 * mode is selected, so a harness in mode `none` never loads the Temporal SDK.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Context } from 'cordis';

import { ConfigError } from '../../../kernel/errors.ts';
import type { StepName } from '../../../harness/core/step-runner.ts';
import { connectRemote, startEmbedded } from './connection.ts';
import type { TemporalLink } from './connection.ts';
import { TemporalDurable } from './durable.ts';

async function link(ctx: Context): Promise<TemporalLink> {
  const { strings, config } = ctx;
  const settings = config.durable.temporal;
  if (config.durable.mode === 'temporal-embedded') {
    const dir =
      config.dataDir === '' || config.dataDir === ':memory:'
        ? join(homedir(), '.yaah', 'temporal')
        : config.dataDir;
    mkdirSync(dir, { recursive: true });
    return startEmbedded({
      namespace: settings.namespace,
      port: settings.port,
      uiPort: settings.uiPort,
      dbFilename: join(dir, 'temporal.db'),
    });
  }
  if (settings.address === '') {
    const message = strings.t('error.durable.address');
    throw new ConfigError('durable.address', message, 'config.toml', 'durable.temporal.address');
  }
  const apiKey = process.env[settings.apiKeyEnv];
  if (apiKey !== undefined) {
    ctx.redactor.add(apiKey);
  }
  try {
    const connected = await connectRemote({
      address: settings.address,
      namespace: settings.namespace,
      apiKey,
      uiUrl: settings.uiUrl,
    });
    return connected;
  } catch (error) {
    // No fallback to another mode: a harness asked to be durable must not quietly not be.
    const reason = ctx.redactor.redactString(
      error instanceof Error ? error.message : String(error),
    );
    const message = strings.t('error.durable.unreachable', { address: settings.address, reason });
    throw new ConfigError(
      'durable.unreachable',
      message,
      'config.toml',
      'durable.temporal.address',
    );
  }
}

/** Connects to (or starts) Temporal and starts the worker for this harness. */
export async function startTemporal(
  ctx: Context,
  isRetrySafe: (name: StepName, input: unknown) => boolean,
): Promise<TemporalDurable> {
  const { mode } = ctx.config.durable;
  if (mode === 'none') {
    throw new Error('startTemporal called in mode none');
  }
  const durable = await TemporalDurable.start({
    mode,
    link: await link(ctx),
    taskQueue: ctx.config.durable.temporal.taskQueue,
    handlers: ctx.taskRuntime.handlers,
    limits: ctx.taskRuntime.limits,
    retry: ctx.config.durable.retry,
    isRetrySafe,
    redactor: ctx.redactor,
  });
  return durable;
}
