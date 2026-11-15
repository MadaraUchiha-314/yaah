/** A local OTLP/HTTP collector for tests: keeps every span it is sent. */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

/** One exported span, as the tests read it. */
export interface CollectedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly raw: string;
}

/** A running collector. */
export interface Collector {
  readonly url: string;
  readonly spans: CollectedSpan[];
  /** Every request body received, joined — for "this text never left the process". */
  body(): string;
  stop(): Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function attributesOf(span: Readonly<Record<string, unknown>>): CollectedSpan['attributes'] {
  const attributes: Record<string, string | number | boolean> = {};
  for (const entry of list(span['attributes'])) {
    if (isRecord(entry) && typeof entry['key'] === 'string' && isRecord(entry['value'])) {
      const [value] = Object.values(entry['value']);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attributes[entry['key']] = value;
      }
    }
  }
  return attributes;
}

function spansOf(body: string): CollectedSpan[] {
  const parsed: unknown = JSON.parse(body);
  const found: CollectedSpan[] = [];
  for (const resource of list(isRecord(parsed) ? parsed['resourceSpans'] : [])) {
    for (const scope of list(isRecord(resource) ? resource['scopeSpans'] : [])) {
      for (const span of list(isRecord(scope) ? scope['spans'] : [])) {
        if (isRecord(span)) {
          const parent = span['parentSpanId'];
          found.push({
            name: String(span['name']),
            traceId: String(span['traceId']),
            spanId: String(span['spanId']),
            parentSpanId: typeof parent === 'string' && parent !== '' ? parent : undefined,
            attributes: attributesOf(span),
            raw: JSON.stringify(span),
          });
        }
      }
    }
  }
  return found;
}

/** Starts a collector on a free loopback port. */
export async function startCollector(): Promise<Collector> {
  const spans: CollectedSpan[] = [];
  const bodies: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      bodies.push(body);
      if (request.url === '/v1/traces') {
        spans.push(...spansOf(body));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    spans,
    body: (): string => bodies.join('\n'),
    stop: (): Promise<void> =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
