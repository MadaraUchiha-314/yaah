/**
 * A plain static file server for the browser-build tests: it serves the files of one
 * directory and nothing else — no yaah code runs in it. It records every request it is
 * sent, so a test can prove what did and did not leave the page.
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.toml': 'application/toml; charset=utf-8',
};

/** One request the server received. */
export interface ServedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** A running static server. */
export interface StaticServer {
  readonly url: string;
  /** Every request received so far, in order. */
  readonly requests: readonly ServedRequest[];
  stop(): Promise<void>;
}

async function respond(dir: string, request: IncomingMessage): Promise<[number, string, Buffer]> {
  const path = new URL(request.url ?? '/', 'http://static').pathname;
  const file = normalize(join(dir, path === '/' ? 'index.html' : path));
  if (request.method !== 'GET' || !file.startsWith(dir)) {
    return [405, 'text/plain', Buffer.from('static files only')];
  }
  try {
    return [200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file)];
  } catch {
    return [404, 'text/plain', Buffer.from('not found')];
  }
}

/** Serves `dir` on a free loopback port. */
export async function serveStatic(dir: string): Promise<StaticServer> {
  const requests: ServedRequest[] = [];
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const [status, type, body] = await respond(dir, request);
    requests.push({ method: request.method ?? '', path: request.url ?? '', status });
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void serve(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
