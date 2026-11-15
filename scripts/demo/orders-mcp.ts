/**
 * The demo's MCP server, over stdio: two read-only tools a refund desk would have.
 * Started by the demo harness as `<runtime> orders-mcp.ts`.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'orders', version: '1.0.0' });

server.registerTool(
  'lookup_order',
  {
    description: 'Looks up an order by its id: items, price, delivery.',
    inputSchema: z.object({ orderId: z.string() }),
  },
  ({ orderId }) => ({
    content: [
      {
        type: 'text',
        text:
          orderId === 'A-1041'
            ? 'Order A-1041: one ceramic lamp, 240.00 EUR, delivered on 9 November to Lisbon.'
            : `No order ${orderId} was found.`,
      },
    ],
  }),
);

server.registerTool(
  'refund_policy',
  {
    description: 'Returns the refund policy that applies to damaged items.',
    inputSchema: z.object({}),
  },
  () => ({
    content: [
      {
        type: 'text',
        text:
          'Damaged on arrival: full refund within 30 days of delivery. Refunds up to ' +
          '100.00 EUR are approved automatically. A refund above 100.00 EUR needs the ' +
          'explicit approval of the person handling the case before it is promised.',
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
