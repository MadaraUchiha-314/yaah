import { describe, expect, test } from 'bun:test';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:http';

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { createTransport } from './transport.ts';

const http: McpServerConfig = {
  id: 'docs',
  transport: 'http',
  command: undefined,
  args: [],
  env: [],
  url: '',
};

interface Listener {
  readonly url: string;
  readonly requests: IncomingHttpHeaders[];
  close(): void;
}

/** A listener that records the headers of what it is asked and answers with `status`. */
async function listener(status: number, location?: string): Promise<Listener> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    response.writeHead(status, location === undefined ? {} : { location }).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
} as const;

/** Sends one request over a transport built for `url`; resolves with whether it failed. */
async function sendOnce(url: string, headers: Readonly<Record<string, string>>): Promise<boolean> {
  const launch = Object.keys(headers).length === 0 ? {} : { headers };
  const transport = await createTransport({ ...http, url }, launch);
  await transport.start();
  try {
    await transport.send(initialize);
    return false;
  } catch {
    return true;
  } finally {
    await transport.close();
  }
}

describe('createTransport for a server added at run time', () => {
  test('a stdio server is built with the launch environment and working directory', async () => {
    const transport = await createTransport(
      { ...http, transport: 'stdio', command: 'crm-server', url: undefined },
      { env: { PLUGIN_ROOT: '/plugin' }, cwd: '/plugin' },
    );
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  test('fixed headers are sent to the configured endpoint', async () => {
    const endpoint = await listener(500);
    try {
      expect(await sendOnce(endpoint.url, { 'X-Tenant': 'public-tenant' })).toBe(true);
      expect(endpoint.requests[0]?.['x-tenant']).toBe('public-tenant');
    } finally {
      endpoint.close();
    }
  });

  test('a redirect to another origin is not followed, with or without headers', async () => {
    const elsewhere = await listener(500);
    const endpoint = await listener(307, elsewhere.url);
    try {
      expect(await sendOnce(endpoint.url, { 'X-Tenant': 'public-tenant' })).toBe(true);
      expect(await sendOnce(endpoint.url, {})).toBe(true);
      expect(endpoint.requests).toHaveLength(2);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      endpoint.close();
      elsewhere.close();
    }
  });
});
