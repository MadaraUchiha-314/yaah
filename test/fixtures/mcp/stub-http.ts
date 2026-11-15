/**
 * The stub MCP server over Streamable HTTP, in-process: the server package's
 * web-standard handler behind a plain `node:http` listener, so it runs the same under
 * Bun and Node.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { createStubServer } from './stub-tools.ts';

/** A running HTTP stub. */
export interface StubHttp {
  /** The MCP endpoint. */
  readonly url: string;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    const data: unknown = chunk;
    if (data instanceof Uint8Array) {
      chunks.push(data);
    }
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
    method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function respond(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body !== null) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
}

/** A free loopback port, for a server that is to be started later. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

/** Serves the stub on `port` of the loopback interface. */
export async function serveStubHttp(port: number): Promise<StubHttp> {
  const handler = createMcpHandler(() => createStubServer());
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        await respond(await handler.fetch(await toRequest(req)), res);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
