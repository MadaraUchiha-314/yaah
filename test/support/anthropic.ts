/**
 * A stand-in for `fetch` that answers the Anthropic SDK from fixtures, so provider tests
 * need no network, and that keeps what it was sent for assertions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AnthropicFetch } from '../../src/harness/models/llm/anthropic/index.ts';
import { createAnthropicLlm } from '../../src/harness/models/llm/anthropic/index.ts';
import type { LLM, LlmEvent, LlmRequest } from '../../src/harness/models/llm/types.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'llm', 'anthropic');

/** A key no real account has; long enough for the redactor to track. */
export const TEST_KEY = 'sk-ant-test-0123456789abcdef';

/** The text of a fixture under `test/fixtures/llm/anthropic/`. */
export function fixture(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

/** One hand-written stream event. */
export type FakeEvent = Readonly<Record<string, unknown>> & { readonly type: string };

/** An SSE body made of the given stream events. */
export function sse(events: readonly FakeEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** A fake `fetch` and everything it received. */
export interface Replay {
  readonly fetch: AnthropicFetch;
  /** The parsed JSON body of each request, in order. */
  readonly bodies: unknown[];
  /** The headers of each request, in order. */
  readonly headers: Headers[];
  readonly urls: string[];
}

/** A `fetch` that answers every request with `body` and `status`. */
export function replay(body: string, status = 200): Replay {
  const bodies: unknown[] = [];
  const headers: Headers[] = [];
  const urls: string[] = [];
  const fetch: AnthropicFetch = (input, init) => {
    urls.push(input instanceof Request ? input.url : String(input));
    headers.push(new Headers(init?.headers));
    const sent: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    bodies.push(sent);
    const contentType = status === 200 ? 'text/event-stream' : 'application/json';
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': contentType, 'request-id': 'r1' } }),
    );
  };
  return { fetch, bodies, headers, urls };
}

/** A provider for `model` wired to `fake`. */
export function anthropic(fake: Replay, model = 'claude-haiku-5-5'): LLM {
  return createAnthropicLlm({ model, apiKey: TEST_KEY, fetch: fake.fetch });
}

/** Every event of one call. */
export async function collect(llm: LLM, request: LlmRequest): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of llm.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

/** What one call throws, or null. */
export async function failure(llm: LLM, request: LlmRequest): Promise<unknown> {
  try {
    await collect(llm, request);
  } catch (error) {
    return error;
  }
  return null;
}

/** The stream events of a minimal text answer, with the given final usage and stop reason. */
export function answer(stopReason: string, finalUsage?: Record<string, number>): FakeEvent[] {
  const usage = finalUsage ?? { output_tokens: 3 };
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
    { type: 'message_stop' },
  ];
}
