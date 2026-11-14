/**
 * Replays canned HTTP responses to an LLM provider through the SDK's `fetch` option, and
 * records what the provider sent. No network is involved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Json } from '../../src/kernel/json.ts';
import type { LLM, LlmEvent, LlmRequest } from '../../src/harness/models/llm/types.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'llm');

/** One request a provider made. */
export interface SentRequest {
  readonly url: string;
  readonly headers: Headers;
  /** The parsed JSON body. */
  readonly body: Record<string, Json>;
}

/** A fake `fetch` and the requests it received. */
export interface Replay {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: SentRequest[];
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a fixture under `test/fixtures/llm/`. */
export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

/** A streaming response with the given server-sent-event body. */
export function sse(body: string): () => Response {
  return () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A JSON response with the given status, as an API returns for an error. */
export function json(status: number, body: string): () => Response {
  return () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Renders Responses API events as a server-sent-event body. */
export function responsesSse(events: readonly Record<string, Json>[]): string {
  return events
    .map(
      (event) =>
        `event: ${typeof event['type'] === 'string' ? event['type'] : 'message'}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
}

/** Renders Chat Completions chunks as a server-sent-event body ending with `[DONE]`. */
export function chatSse(chunks: readonly Record<string, Json>[], done = true): string {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  return done ? `${body}data: [DONE]\n\n` : body;
}

/**
 * A fake `fetch` whose response sends `head` and then stays open until the request's
 * signal aborts — what a provider sees when a call is cancelled mid-answer.
 */
export function hanging(head: string): Replay['fetch'] {
  return async (_input, init) => {
    await Promise.resolve();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

/** One scripted outcome of a request: a response, or the error `fetch` throws. */
export type Scripted = (() => Response) | Error;

/**
 * A fake `fetch` that answers with `responses` in order (the last one repeats), or throws
 * when a response is an `Error`.
 */
export function replay(...responses: readonly Scripted[]): Replay {
  const requests: SentRequest[] = [];
  let index = 0;
  const fetch: Replay['fetch'] = async (input, init) => {
    await Promise.resolve();
    const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: isRecord(parsed) ? parsed : {},
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined || next instanceof Error) {
      throw next ?? new Error('no response scripted');
    }
    return next();
  };
  return { fetch, requests };
}

/** Collects every event of one call. */
export async function collect(
  llm: LLM,
  request: LlmRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of llm.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

/** Runs one call and returns what it threw, or null. */
export async function failure(llm: LLM, request: LlmRequest): Promise<unknown> {
  try {
    await collect(llm, request);
  } catch (error) {
    return error;
  }
  return null;
}
