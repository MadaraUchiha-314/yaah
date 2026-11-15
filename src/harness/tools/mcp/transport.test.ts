import { describe, expect, test } from 'bun:test';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { McpServerConfig } from '../../../kernel/config-types.ts';
import { McpConfigError, createTransport, localityUrl, stdioEnvironment } from './transport.ts';

const stdio: McpServerConfig = {
  id: 'crm',
  transport: 'stdio',
  command: '/usr/bin/crm-server',
  args: ['--quiet'],
  env: [],
  url: undefined,
};
const http: McpServerConfig = {
  id: 'docs',
  transport: 'http',
  command: undefined,
  args: [],
  env: [],
  url: 'http://127.0.0.1:9/mcp',
};

/** What `attempt` rejects with, or null when it resolves. */
async function failure(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt;
    return null;
  } catch (error) {
    return error;
  }
}

describe('stdioEnvironment', () => {
  const source = { PATH: '/bin', CRM_TOKEN: 'token', OPENAI_API_KEY: 'sk-secret', HOME: '/root' };

  test('passes only the named variables, and PATH', () => {
    expect(stdioEnvironment(['CRM_TOKEN'], source)).toEqual({ PATH: '/bin', CRM_TOKEN: 'token' });
  });

  test('passes nothing but PATH when no variable is named', () => {
    expect(stdioEnvironment([], source)).toEqual({ PATH: '/bin' });
  });

  test('leaves out a named variable that is not set', () => {
    expect(stdioEnvironment(['MISSING'], { CRM_TOKEN: 'token' })).toEqual({});
  });

  test('reads the process environment by default', () => {
    expect(Object.keys(stdioEnvironment([]))).toEqual(
      process.env['PATH'] === undefined ? [] : ['PATH'],
    );
  });
});

describe('createTransport', () => {
  test('a stdio server gets the stdio transport', async () => {
    expect(await createTransport(stdio)).toBeInstanceOf(StdioClientTransport);
  });

  test('an http server gets the Streamable HTTP transport', async () => {
    expect(await createTransport(http)).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  test('a stdio server without a command is a configuration error', async () => {
    const error = await failure(createTransport({ ...stdio, command: undefined }));
    expect(error).toBeInstanceOf(McpConfigError);
    expect(error instanceof Error ? error.message : '').toContain('crm');
  });

  test('an http server without a usable URL is a configuration error', async () => {
    for (const url of [undefined, 'not a url', 'ftp://example.test/mcp']) {
      // oxlint-disable-next-line no-await-in-loop -- three cases, in order
      expect(await failure(createTransport({ ...http, url }))).toBeInstanceOf(McpConfigError);
    }
  });
});

describe('localityUrl', () => {
  test('is the endpoint of an http server', () => {
    expect(localityUrl(http)).toBe('http://127.0.0.1:9/mcp');
  });

  test('names the command of a stdio server', () => {
    expect(localityUrl(stdio)).toBe('stdio:/usr/bin/crm-server');
    expect(localityUrl({ ...stdio, command: undefined })).toBe('stdio:');
  });
});
