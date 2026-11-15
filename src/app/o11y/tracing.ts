/**
 * Tracing with OpenTelemetry. One trace follows a request from the A2A call through the
 * steps of the task it reached, and out again to the agents and MCP servers a step
 * calls. Spans are named by the GenAI semantic conventions.
 *
 * No global OpenTelemetry state is registered: parents are passed explicitly, so several
 * harnesses can trace in one process.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Attributes, Context as OtelContext, Span, Tracer } from '@opentelemetry/api';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import type { Redactor } from '../../kernel/redactor.ts';

/** Options of {@link Tracing}. */
export interface TracingOptions {
  readonly redactor: Redactor;
  /** Where finished spans go. Without one, spans exist only to give records a trace id. */
  readonly exporter?: SpanExporter | undefined;
  readonly serviceName?: string | undefined;
  readonly serviceVersion?: string | undefined;
}

/** What a span is started with. */
export interface SpanInit {
  readonly name: string;
  readonly kind?: SpanKind | undefined;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
}

/** A started span and the scope that makes it the parent of what runs inside. */
export interface OpenSpan {
  readonly traceId: string;
  /** Adds attributes; strings are redacted. */
  set(attributes: Readonly<Record<string, string | number | boolean | undefined>>): void;
  rename(name: string): void;
  /** Runs `body` with this span as the current one. */
  run<T>(body: () => T): T;
  /** Ends the span, as failed when `error` is given. */
  end(error?: unknown): void;
}

/** The tracer of one harness. */
export class Tracing {
  readonly #provider: BasicTracerProvider;
  readonly #tracer: Tracer;
  readonly #redactor: Redactor;
  readonly #propagator = new W3CTraceContextPropagator();
  readonly #scope = new AsyncLocalStorage<OtelContext>();
  /** The request each task was last reached by: its steps continue that trace. */
  readonly #tasks = new Map<string, OtelContext>();

  constructor(options: TracingOptions) {
    this.#redactor = options.redactor;
    this.#provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        'service.name': options.serviceName ?? 'yaah',
        ...(options.serviceVersion === undefined
          ? {}
          : { 'service.version': options.serviceVersion }),
      }),
      spanProcessors:
        options.exporter === undefined ? [] : [new BatchSpanProcessor(options.exporter)],
    });
    this.#tracer = this.#provider.getTracer('yaah');
  }

  /** Starts the span of an incoming request, continuing the caller's trace if it sent one. */
  startRequest(traceparent: string | undefined, init: SpanInit): OpenSpan {
    const parent =
      traceparent === undefined
        ? ROOT_CONTEXT
        : this.#propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
    return this.#open(init, parent);
  }

  /** Starts a span for a step of `taskId`, inside the trace of the request that reached it. */
  startStep(taskId: string, init: SpanInit): OpenSpan {
    return this.#open(init, this.#tasks.get(taskId) ?? ROOT_CONTEXT);
  }

  /** Makes the request running right now the one `taskId`'s steps belong to. */
  bindTask(taskId: string): void {
    const current = this.#scope.getStore();
    if (current !== undefined) {
      this.#tasks.set(taskId, current);
    }
  }

  /** Forgets a task that has ended. */
  releaseTask(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  /** The trace id of the work running right now, or of `taskId`'s latest request. */
  traceId(taskId?: string): string | undefined {
    const context =
      this.#scope.getStore() ?? (taskId === undefined ? undefined : this.#tasks.get(taskId));
    return context === undefined ? undefined : trace.getSpanContext(context)?.traceId;
  }

  /** The W3C `traceparent` to send with a call made right now. */
  traceparent(): string | undefined {
    const current = this.#scope.getStore();
    if (current === undefined) {
      return undefined;
    }
    const carrier: Record<string, string> = {};
    this.#propagator.inject(current, carrier, defaultTextMapSetter);
    return carrier['traceparent'];
  }

  /** Sends what is buffered and stops. */
  async shutdown(): Promise<void> {
    await this.#provider.shutdown();
  }

  #attributes(values: SpanInit['attributes']): Attributes {
    const attributes: Attributes = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value !== undefined) {
        attributes[key] = typeof value === 'string' ? this.#redactor.redactString(value) : value;
      }
    }
    return attributes;
  }

  #open(init: SpanInit, parent: OtelContext): OpenSpan {
    const span: Span = this.#tracer.startSpan(
      this.#redactor.redactString(init.name),
      { kind: init.kind ?? SpanKind.INTERNAL, attributes: this.#attributes(init.attributes) },
      parent,
    );
    const context = trace.setSpan(parent, span);
    return {
      traceId: span.spanContext().traceId,
      set: (attributes: SpanInit['attributes']): void => {
        span.setAttributes(this.#attributes(attributes));
      },
      rename: (name: string): void => {
        span.updateName(this.#redactor.redactString(name));
      },
      run: <T>(body: () => T): T => this.#scope.run(context, body),
      end: (error?: unknown): void => {
        if (error !== undefined) {
          // oxlint-disable-next-line typescript/no-base-to-string -- any thrown value is described
          const message = error instanceof Error ? error.message : String(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: this.#redactor.redactString(message),
          });
          span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
        }
        span.end();
      },
    };
  }
}
