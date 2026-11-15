/**
 * A policy MCP server for the hook tests: one tool, `check`, that is handed a lifecycle
 * event and answers with a decision. Served in-process over Streamable HTTP, so a test
 * can read what it was asked.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { StubHttp } from './stub-http.ts';
import { serveMcpHttp } from './stub-http.ts';

/** What `check` answers: a decision object, or any text to answer with as it is. */
export type PolicyAnswer = { decision: 'allow' | 'deny'; reason?: string } | string;

/** A running policy server. */
export interface PolicyServer extends StubHttp {
  /** Every event `check` was called with, in order. */
  readonly asked: Record<string, unknown>[];
}

/** Serves a policy server on `port` whose `check` answers what `decide` returns. */
export async function servePolicy(
  port: number,
  decide: (event: Record<string, unknown>) => PolicyAnswer,
): Promise<PolicyServer> {
  const asked: Record<string, unknown>[] = [];
  const http = await serveMcpHttp(port, () => {
    const server = new McpServer({ name: 'policy', version: '1.0.0' });
    server.registerTool(
      'check',
      {
        description: 'Decides whether a lifecycle event may proceed.',
        inputSchema: z.looseObject({ event: z.string() }),
        annotations: { readOnlyHint: true },
      },
      (event) => {
        asked.push(event);
        const answer = decide(event);
        const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
        return { content: [{ type: 'text', text }] };
      },
    );
    return server;
  });
  return { ...http, asked };
}
