/**
 * A stub MCP server over stdio, for the integration tests. Started by the harness as
 * `<runtime> stub-server.ts`, under Bun or Node.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createStubServer } from './stub-tools.ts';

await createStubServer().connect(new StdioServerTransport());
