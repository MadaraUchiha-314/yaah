/**
 * The OpenAI provider (Responses API) against the `llm` contract and its own mapping
 * rules. Every HTTP response is replayed through the SDK's `fetch` option; the fixtures
 * under `test/fixtures/llm/openai/` are refreshed with `scripts/record-llm-fixtures.ts`.
 */
import { describe, expect, test } from 'bun:test';

import { createOpenAiLlm } from '../../src/harness/models/llm/openai/provider.ts';
import type { LLM, LlmRequest } from '../../src/harness/models/llm/types.ts';
import { LlmError } from '../../src/harness/models/llm/types.ts';
import type { Json } from '../../src/kernel/json.ts';
import { llmContract } from '../../src/testing/llm-contract.ts';
import type { Replay, Scripted } from '../support/llm-http.ts';
import {
  collect,
  failure,
  fixture,
  hanging,
  json,
  replay,
  responsesSse,
  sse,
} from '../support/llm-http.ts';

const KEY = 'sk-fixture-secret-key-0001';
const MODEL = 'gpt-6.1-sol';

function llm(http: Replay): LLM {
  return createOpenAiLlm({ model: MODEL, apiKey: KEY, fetch: http.fetch });
}

function replaying(...responses: readonly Scripted[]): LLM {
  return llm(replay(...responses));
}

const TEXT = sse(fixture('openai/text.sse'));
const HI: LlmRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [],
};

function completed(extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    type: 'response.completed',
    response: {
      status: 'completed',
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 13,
      },
      ...extra,
    },
  };
}

llmContract({ describe, expect, test }, 'openai', {
  text: () => replaying(TEXT),
  parallelTools: () => replaying(sse(fixture('openai/parallel-tools.sse'))),
  retryableError: () => replaying(json(429, fixture('openai/error-429.json'))),
  fatalError: () => replaying(json(400, fixture('openai/error-400.json'))),
});

describe('openai provider: entity', () => {
  test('is addressed as openai/<model> and reached over https', () => {
    const subject = replaying(TEXT);
    expect(subject.ref).toEqual({ kind: 'llm', id: 'openai/gpt-6.1-sol', version: null });
    expect(subject.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://api.openai.com/v1',
    });
    expect(subject.description.length > 0).toBe(true);
  });

  test('sends requests to the configured base URL with the key as a bearer token', async () => {
    const http = replay(TEXT);
    const subject = createOpenAiLlm({
      model: MODEL,
      apiKey: KEY,
      baseUrl: 'https://proxy.example/v1',
      fetch: http.fetch,
    });
    await collect(subject, HI);
    expect(http.requests[0]?.url).toBe('https://proxy.example/v1/responses');
    expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(subject.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://proxy.example/v1',
    });
  });
});

describe('openai provider: request mapping', () => {
  test('asks for a stateless streamed response that returns encrypted reasoning', async () => {
    const http = replay(TEXT);
    await collect(llm(http), HI);
    const body = http.requests[0]?.body;
    expect(body?.['model']).toBe(MODEL);
    expect(body?.['stream']).toBe(true);
    expect(body?.['store']).toBe(false);
    expect(body?.['include']).toEqual(['reasoning.encrypted_content']);
    expect(body?.['tools']).toBeUndefined();
    expect(body?.['reasoning']).toBeUndefined();
    expect(body?.['prompt_cache_key']).toBeUndefined();
    expect(body?.['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    ]);
  });

  test('maps system text, tool declarations, effort and the cache key', async () => {
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }], cacheBoundary: true },
        ...HI.messages,
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look an order up.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
      effort: 'high',
      cacheKey: 'task-42',
    });
    const body = http.requests[0]?.body;
    expect(body?.['input']).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    ]);
    expect(body?.['tools']).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look an order up.',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        strict: false,
      },
    ]);
    expect(body?.['parallel_tool_calls']).toBe(true);
    expect(body?.['reasoning']).toEqual({ effort: 'high' });
    expect(body?.['prompt_cache_key']).toBe('task-42');
  });

  test('leaves out an effort the API does not know', async () => {
    const http = replay(TEXT);
    await collect(llm(http), { ...HI, effort: 'enormous' });
    expect(http.requests[0]?.body['reasoning']).toBeUndefined();
  });

  test('maps images, other files and data parts of a user message', async () => {
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'file', mediaType: 'image/png', source: { kind: 'base64', data: 'aGk=' } },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              source: { kind: 'url', url: 'https://img.example/a.jpg' },
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              name: 'a.pdf',
              source: { kind: 'base64', data: 'cGRm' },
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              source: { kind: 'url', url: 'https://doc.example/b.pdf' },
            },
            { type: 'data', mediaType: 'application/json', data: { total: 3 } },
          ],
        },
      ],
      tools: [],
    });
    expect(http.requests[0]?.body['input']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aGk=' },
          { type: 'input_image', detail: 'auto', image_url: 'https://img.example/a.jpg' },
          {
            type: 'input_file',
            filename: 'a.pdf',
            file_data: 'data:application/pdf;base64,cGRm',
          },
          { type: 'input_file', file_url: 'https://doc.example/b.pdf' },
          { type: 'input_text', text: '{"total":3}' },
        ],
      },
    ]);
  });

  test('sends an assistant turn back as reasoning, text and function calls, in order', async () => {
    const reasoning = {
      id: 'rs_1',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAAB-opaque',
    };
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        ...HI.messages,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', opaque: { provider: 'openai', data: reasoning } },
            { type: 'reasoning', opaque: { provider: 'anthropic', data: { signature: 'x' } } },
            { type: 'reasoning', opaque: { provider: 'openai', data: 'not an item' } },
            { type: 'text', text: 'Let me check.' },
            { type: 'tool-call', call: { id: 'call_a', name: 'lookup', args: { id: 'A-1' } } },
            { type: 'tool-call', call: { id: 'call_b', name: 'rules', args: {} } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              callId: 'call_b',
              result: { ok: false, error: { code: 'timeout', message: 'too slow' } },
            },
            {
              type: 'tool-result',
              callId: 'call_a',
              result: {
                ok: true,
                content: [
                  { type: 'text', text: 'Order A-1' },
                  { type: 'data', mediaType: 'application/json', data: { paid: true } },
                ],
              },
            },
          ],
        },
      ],
      tools: [],
    });
    expect(http.requests[0]?.body['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      reasoning,
      { role: 'assistant', content: 'Let me check.' },
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"id":"A-1"}' },
      { type: 'function_call', call_id: 'call_b', name: 'rules', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'Order A-1\n{"paid":true}' },
      { type: 'function_call_output', call_id: 'call_b', output: 'Error (timeout): too slow' },
    ]);
  });

  test('sends an image in a tool result as structured output', async () => {
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              callId: 'call_a',
              result: {
                ok: true,
                content: [
                  { type: 'text', text: 'Screenshot' },
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    source: { kind: 'base64', data: 'aGk=' },
                  },
                ],
              },
            },
          ],
        },
      ],
      tools: [],
    });
    expect(http.requests[0]?.body['input']).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_a',
        output: [
          { type: 'input_text', text: 'Screenshot' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aGk=' },
        ],
      },
    ]);
  });
});

describe('openai provider: response mapping', () => {
  test('reports usage including cached input tokens', async () => {
    const events = await collect(replaying(TEXT), HI);
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end',
      usage: { inputTokens: 70, outputTokens: 8, cachedInputTokens: 0 },
    });
  });

  test('emits a reasoning item unchanged, before the content it led to', async () => {
    const events = await collect(replaying(sse(fixture('openai/reasoning-tools.sse'))), HI);
    expect(events.map((event) => event.type)).toEqual(['reasoning', 'tool-call', 'done']);
    const [first, second] = events;
    const data = first?.type === 'reasoning' ? first.opaque.data : null;
    expect(first?.type === 'reasoning' ? first.opaque.provider : '').toBe('openai');
    expect(JSON.stringify(data)).toMatch(/"id":"rs_[^"]+"/u);
    expect(data).toMatchObject({ type: 'reasoning' });
    // The item is passed on exactly as the API sent it, encrypted content included.
    expect(JSON.stringify(data)).toContain('"encrypted_content":"gAAAA');
    expect(second).toMatchObject({
      type: 'tool-call',
      call: { name: 'lookup', args: { id: 'A-3' } },
    });
  });

  test('a reasoning item it emitted goes back unchanged on the next request', async () => {
    const http = replay(sse(fixture('openai/reasoning-tools.sse')), TEXT);
    const subject = llm(http);
    const first = await collect(subject, HI);
    const reasoning = first.flatMap((event) => (event.type === 'reasoning' ? [event] : []));
    await collect(subject, {
      messages: [...HI.messages, { role: 'assistant', content: reasoning }],
      tools: [],
    });
    const input = http.requests[1]?.body['input'];
    expect(reasoning).toHaveLength(1);
    expect(Array.isArray(input) ? input[1] : null).toEqual(reasoning[0]?.opaque.data ?? null);
  });

  test('treats empty tool arguments as an empty object', async () => {
    const item = { type: 'function_call', call_id: 'c1', name: 'rules', arguments: '' };
    const body = responsesSse([{ type: 'response.output_item.done', item }, completed()]);
    const events = await collect(replaying(sse(body)), HI);
    expect(events[0]).toEqual({ type: 'tool-call', call: { id: 'c1', name: 'rules', args: {} } });
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4 },
    });
  });

  test('reports a truncated answer as length and missing usage as zero', async () => {
    const body = responsesSse([
      { type: 'response.output_text.delta', delta: 'Hel' },
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      },
    ]);
    const events = await collect(replaying(sse(body)), HI);
    expect(events).toEqual([
      { type: 'text.delta', text: 'Hel' },
      {
        type: 'done',
        stopReason: 'length',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
    ]);
  });

  test('reports a refusal, and a filtered answer, as refusal', async () => {
    const refused = responsesSse([
      { type: 'response.refusal.delta', delta: 'I cannot help with that.' },
      completed(),
    ]);
    const events = await collect(replaying(sse(refused)), HI);
    expect(events[0]).toEqual({ type: 'text.delta', text: 'I cannot help with that.' });
    expect(events.at(-1)?.type === 'done' ? events.at(-1) : null).toEqual({
      type: 'done',
      stopReason: 'refusal',
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4 },
    });
    const filtered = responsesSse([
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      },
    ]);
    const last = (await collect(replaying(sse(filtered)), HI)).at(-1);
    expect(last?.type === 'done' ? last.stopReason : '').toBe('refusal');
  });
});

describe('openai provider: errors', () => {
  async function llmError(subject: LLM): Promise<LlmError> {
    const error = await failure(subject, HI);
    if (!(error instanceof LlmError)) {
      throw new TypeError(`expected an LlmError, got ${String(error)}`);
    }
    return error;
  }

  test('maps HTTP statuses to retryable or fatal', async () => {
    const body = fixture('openai/error-400.json');
    const outcomes: Record<number, boolean> = {};
    for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503]) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      outcomes[status] = (await llmError(replaying(json(status, body)))).retryable;
    }
    expect(outcomes).toEqual({
      400: false,
      401: false,
      403: false,
      404: false,
      408: true,
      409: true,
      422: false,
      429: true,
      500: true,
      502: true,
      503: true,
    });
  });

  test('does not retry by itself: one failed response is one request', async () => {
    const http = replay(json(429, fixture('openai/error-429.json')));
    const error = await llmError(llm(http));
    expect(http.requests.length).toBe(1);
    expect(error.provider).toBe('openai');
    expect(error.model).toBe(MODEL);
    expect(error.code).toBe('llm.retryable');
    expect(error.message).toContain('429');
    expect(error.message).toContain('rate_limit_exceeded');
  });

  test('a connection failure is retryable', async () => {
    const error = await llmError(replaying(new TypeError('fetch failed')));
    expect(error.retryable).toBe(true);
  });

  test('never puts the key, or an upstream body, in the error', async () => {
    const leaking = JSON.stringify({
      error: { message: `Incorrect API key provided: ${KEY}.`, type: `bad ${KEY}`, code: KEY },
    });
    for (const status of [400, 401, 500]) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      const error = await llmError(replaying(json(status, leaking)));
      expect(error.message.includes(KEY)).toBe(false);
      expect(error.message.includes('Incorrect API key')).toBe(false);
      expect(String(error.cause).includes(KEY)).toBe(false);
    }
    const thrown = await llmError(replaying(new Error(`connect failed for ${KEY}`)));
    expect(thrown.message.includes(KEY)).toBe(false);
  });

  test('a failed response is an error: retryable for a server fault, fatal otherwise', async () => {
    const failed = (code: string): string =>
      responsesSse([
        {
          type: 'response.failed',
          response: { status: 'failed', error: { code, message: 'upstream detail' } },
        },
      ]);
    const server = await llmError(replaying(sse(failed('server_error'))));
    expect(server.retryable).toBe(true);
    expect(server.message).toContain('server_error');
    expect(server.message.includes('upstream detail')).toBe(false);
    expect((await llmError(replaying(sse(failed('rate_limit_exceeded'))))).retryable).toBe(true);
    expect((await llmError(replaying(sse(failed('invalid_prompt'))))).retryable).toBe(false);
  });

  test('an error event in the stream is an error', async () => {
    const event = (code: Json): string =>
      responsesSse([{ type: 'error', code, message: 'upstream detail', param: null }]);
    expect((await llmError(replaying(sse(event('server_error'))))).retryable).toBe(true);
    expect((await llmError(replaying(sse(event('invalid_prompt'))))).retryable).toBe(false);
    expect((await llmError(replaying(sse(event(null))))).retryable).toBe(true);
    // The same payload without an SSE event name is not intercepted by the SDK.
    const unnamed = `data: ${JSON.stringify({ type: 'error', code: 'invalid_prompt' })}\n\n`;
    expect((await llmError(replaying(sse(unnamed)))).retryable).toBe(false);
  });

  test('a stream that ends before the response completes is retryable', async () => {
    const body = responsesSse([{ type: 'response.output_text.delta', delta: 'Hel' }]);
    const error = await llmError(replaying(sse(body)));
    expect(error.retryable).toBe(true);
  });

  test('tool arguments that are not JSON are a retryable error', async () => {
    const item = { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"id":' };
    const body = responsesSse([{ type: 'response.output_item.done', item }, completed()]);
    const error = await llmError(replaying(sse(body)));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('lookup');
  });

  test('aborting mid-answer ends the stream with a fatal error', async () => {
    const head = responsesSse([{ type: 'response.output_text.delta', delta: 'Hel' }]);
    const subject = createOpenAiLlm({ model: MODEL, apiKey: KEY, fetch: hanging(head) });
    const controller = new AbortController();
    const seen: string[] = [];
    let caught: unknown = null;
    try {
      for await (const event of subject.stream(HI, controller.signal)) {
        seen.push(event.type);
        controller.abort();
      }
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual(['text.delta']);
    expect(caught instanceof LlmError && !caught.retryable).toBe(true);
  });

  test('an aborted signal is a fatal error and sends nothing', async () => {
    const http = replay(TEXT);
    const controller = new AbortController();
    controller.abort();
    let caught: unknown = null;
    try {
      await collect(llm(http), HI, controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof LlmError && !caught.retryable).toBe(true);
    expect(http.requests.length).toBe(0);
  });
});
