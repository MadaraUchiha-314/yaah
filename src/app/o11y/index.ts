/**
 * The observability plugin: structured logs and OpenTelemetry traces of everything a
 * task does. Provides the `log` and `tracing` services (cordis keeps the name `logger` for itself).
 *
 * It only listens — to requests, to the inbox, to every step, to commands — so removing
 * it from a composition changes nothing but what is recorded.
 */
import { SpanKind } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Context } from 'cordis';
import type { Request, Response } from 'express';

import type { StepCall } from '../../harness/core/step-middleware.ts';
import type { InboxItem } from '../../harness/core/types.ts';
// For the heartbeat's events, which this plugin logs.
import type { Heartbeat } from '../heartbeat/index.ts';
import { addTraceparentSource } from '../../kernel/trace-context.ts';
import { Logger, fileWriter, stderrWriter } from './logger.ts';
import { endFacts, logFacts, recordTypeOf, spanNameOf, startFacts } from './steps.ts';
import { Tracing } from './tracing.ts';

declare module 'cordis' {
  interface Context {
    /** Writes structured log records. */
    log: Logger;
    /** The heartbeat, when the composition has one; its events are logged here. */
    heartbeat: Heartbeat;
    /** Starts spans and knows the trace of the running work. */
    tracing: Tracing;
  }
}

export const name = 'o11y';
export const inject: readonly string[] = ['config', 'redactor', 'taskRuntime'];

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'canceled', 'failed']);

function header(request: Request, key: string): string | undefined {
  const value = request.headers[key];
  return typeof value === 'string' ? value : undefined;
}

/** Traces and logs one HTTP request; the rest of the request runs inside its span. */
function onRequest(ctx: Context, request: Request, response: Response, next: () => void): true {
  const span = ctx.tracing.startRequest(header(request, 'traceparent'), {
    name: `${request.method} ${request.path}`,
    kind: SpanKind.SERVER,
    attributes: { 'http.request.method': request.method, 'url.path': request.path },
  });
  ctx.log.record(
    'request.received',
    { traceId: span.traceId, method: request.method, path: request.path },
    'debug',
  );
  response.once('close', () => {
    span.set({ 'http.response.status_code': response.statusCode });
    span.end();
  });
  span.run(next);
  return true;
}

/** Runs one step inside a span and writes its record when it ends. */
async function observeStep<T>(ctx: Context, call: StepCall, next: () => Promise<T>): Promise<T> {
  const task = ctx.taskRuntime.taskStore.get(call.taskId);
  const settings = await ctx.taskRuntime.tasks.load(call.taskId).catch(() => null);
  const model = settings?.llm ?? ctx.config.model.llm;
  const started = startFacts(call, model);
  const span = ctx.tracing.startStep(call.taskId, {
    name: spanNameOf(call, model),
    kind: call.name === 'llm.invoke' ? SpanKind.CLIENT : SpanKind.INTERNAL,
    attributes: { ...started, 'yaah.task.id': call.taskId, 'yaah.step.key': call.key },
  });
  const base = {
    taskId: call.taskId,
    contextId: task?.contextId,
    traceId: span.traceId,
    stepName: call.name,
    stepId: call.key,
  };
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  try {
    const output = await span.run(next);
    const ended = endFacts(call, output);
    span.set(ended);
    span.end();
    ctx.log.record(recordTypeOf(call), {
      ...base,
      ...logFacts({ ...started, ...ended }),
      durationMs: elapsed(),
      outcome: 'ok',
    });
    if (TERMINAL.has(String(ended['yaah.task.state']))) {
      ctx.tracing.releaseTask(call.taskId);
    }
    return output;
  } catch (error) {
    span.end(error);
    ctx.log.record(
      recordTypeOf(call),
      {
        ...base,
        ...logFacts(started),
        durationMs: elapsed(),
        outcome: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
      'error',
    );
    throw error;
  }
}

function listen(ctx: Context): void {
  ctx.on('http/request', (request: Request, response: Response, next: () => void) =>
    onRequest(ctx, request, response, next),
  );
  ctx.on('inbox/accepted', (item: InboxItem, contextId: string) => {
    ctx.tracing.bindTask(item.taskId);
    ctx.log.record('inbox.accepted', {
      taskId: item.taskId,
      contextId,
      traceId: ctx.tracing.traceId(item.taskId),
      itemId: item.id,
      kind: item.payload.kind,
      interrupt: item.interrupt,
    });
  });
  ctx.on('inbox/discarded', (taskId: string, reason: string) => {
    ctx.log.record('inbox.discarded', { taskId, reason }, 'warn');
  });
  ctx.on('command/invoked', (command: string) => {
    ctx.log.record('command.invoked', { command, traceId: ctx.tracing.traceId() });
  });
  ctx.on('command/executed', (command: string) => {
    ctx.log.record('command.executed', { command, traceId: ctx.tracing.traceId() });
  });
  ctx.on('command/failed', (command: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.record(
      'command.failed',
      { command, error: reason, traceId: ctx.tracing.traceId() },
      'error',
    );
  });
  ctx.on('task/stalled', (taskId: string, idleMs: number) => {
    ctx.log.record('task.stalled', { taskId, idleMs }, 'warn');
  });
  ctx.on('heartbeat/tick', (_at: Date, redelivered: number) => {
    ctx.log.record('heartbeat.tick', { redelivered }, 'debug');
  });
  ctx.on('heartbeat/failed', (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.record('harness.event', { event: 'heartbeat/failed', error: reason }, 'error');
  });
  ctx.on('durable/run-error', (taskId: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.record('harness.event', { event: 'durable/run-error', taskId, error: reason }, 'error');
  });
}

/** Starts logging and tracing. */
export function apply(ctx: Context): void {
  const { o11y } = ctx.config;
  const logger = new Logger({
    level: o11y.logLevel,
    redactor: ctx.redactor,
    write: o11y.logFile === undefined ? stderrWriter : fileWriter(o11y.logFile),
  });
  const tracing = new Tracing({
    redactor: ctx.redactor,
    exporter:
      o11y.otlpEndpoint === undefined
        ? undefined
        : new OTLPTraceExporter({ url: `${o11y.otlpEndpoint.replace(/\/$/u, '')}/v1/traces` }),
  });
  ctx.effect(() => {
    const releaseLogger = ctx.provide('log', logger);
    const releaseTracing = ctx.provide('tracing', tracing);
    const removeSource = addTraceparentSource(() => tracing.traceparent());
    const removeMiddleware = ctx.taskRuntime.addStepMiddleware(
      <T>(call: StepCall, next: () => Promise<T>): Promise<T> => observeStep(ctx, call, next),
    );
    return async (): Promise<void> => {
      removeMiddleware();
      removeSource();
      releaseTracing();
      releaseLogger();
      await tracing.shutdown();
    };
  });
  listen(ctx);
}
