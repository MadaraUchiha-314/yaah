/**
 * The tools of the stub MCP server the integration tests talk to. Kept apart from the
 * stdio entry point so the same server can be served over Streamable HTTP in-process.
 *
 * Runs under Bun and under Node's type stripping: no enums, no parameter properties.
 */
import { appendFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Names the file `refund` appends one line to per call, so a test can count calls. */
export const REFUND_LOG_ENV = 'STUB_REFUND_LOG';
/** Overrides how long `refund` takes, in milliseconds. */
export const REFUND_DELAY_ENV = 'STUB_REFUND_DELAY_MS';
/** The order id `lookup_order` reports as an error. */
export const MISSING_ORDER = 'missing';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Builds a fresh stub server: one per stdio connection or HTTP request. */
export function createStubServer(): McpServer {
  const server = new McpServer({ name: 'stub', version: '1.0.0' });
  const order = z.object({ id: z.string() });
  const nothing = z.object({});

  server.registerTool(
    'lookup_order',
    {
      description: 'Looks an order up by its id.',
      inputSchema: order,
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      if (id === MISSING_ORDER) {
        return { isError: true, content: [{ type: 'text', text: `No order has the id ${id}.` }] };
      }
      return {
        content: [{ type: 'text', text: `Order ${id} is shipped.` }],
        structuredContent: { id, status: 'shipped' },
      };
    },
  );

  server.registerTool(
    'refund_rules',
    {
      description: 'Returns the refund policy.',
      inputSchema: nothing,
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: 'Refunds are possible within 30 days.' }] }),
  );

  server.registerTool(
    'refund',
    {
      description: 'Refunds an order. Slow, and not safe to repeat.',
      inputSchema: order,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ id }) => {
      await sleep(Number(process.env[REFUND_DELAY_ENV] ?? '150'));
      const log = process.env[REFUND_LOG_ENV];
      if (log !== undefined) {
        await appendFile(log, `${id}\n`);
      }
      return { content: [{ type: 'text', text: `Refunded order ${id}.` }] };
    },
  );

  server.registerTool(
    'dump_env',
    {
      description: 'Returns the names of the environment variables it was started with.',
      inputSchema: nothing,
      annotations: { readOnlyHint: true },
    },
    () => ({
      content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).toSorted()) }],
    }),
  );

  return server;
}
