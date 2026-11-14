/**
 * The OpenAI-compatible provider (Chat Completions API) against the `llm` contract and
 * its own mapping rules. Every HTTP response is replayed through the SDK's `fetch` option;
 * the fixtures under `test/fixtures/llm/openai-compatible/` are refreshed with
 * `scripts/record-llm-fixtures.ts`.
 */
import { describe, expect, test } from 'bun:test';

import { createCompatibleLlm } from '../../src/harness/models/llm/openai-compatible/provider.ts';
import type { LLM, LlmRequest } from '../../src/harness/models/llm/types.ts';
import { LlmError } from '../../src/harness/models/llm/types.ts';
import type { Json } from '../../src/kernel/json.ts';
import { llmContract } from '../../src/testing/llm-contract.ts';
import type { Replay, Scripted } from '../support/llm-http.ts';
import {
  chatSse,
  collect,
  failure,
  fixture,
  hanging,
  json,
  replay,
  sse,
} from '../support/llm-http.ts';

const KEY = 'sk-fixture-secret-key-0001';
const BASE_URL = 'https://openrouter.example/api/v1';
const CAPABILITIES = { contextWindow: 32_000, maxOutput: 4096, input: [], efforts: [] };

function llm(http: Replay, keyed = true): LLM {
  return createCompatibleLlm({
    providerId: 'router',
    model: 'vendor/model-1',
    baseUrl: BASE_URL,
    apiKey: keyed ? KEY : undefined,
    capabilities: CAPABILITIES,
    fetch: http.fetch,
  });
}

function replaying(...responses: readonly Scripted[]): LLM {
  return llm(replay(...responses));
}

const TEXT = sse(fixture('openai-compatible/text.sse'));
const HI: LlmRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [],
};

function chunk(delta: Record<string, Json>, finish: string | null = null): Record<string, Json> {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

llmContract({ describe, expect, test }, 'openai-compatible', {
  text: () => replaying(TEXT),
  parallelTools: () => replaying(sse(fixture('openai-compatible/parallel-tools.sse'))),
  retryableError: () => replaying(json(429, fixture('openai-compatible/error-429.json'))),
  fatalError: () => replaying(json(401, fixture('openai-compatible/error-401.json'))),
});

describe('openai-compatible provider: entity', () => {
  test('is addressed as <provider>/<model> and reached at its base URL', async () => {
    const http = replay(TEXT);
    const subject = llm(http);
    expect(subject.ref).toEqual({ kind: 'llm', id: 'router/vendor/model-1', version: null });
    expect(subject.locality).toEqual({ type: 'remote', protocol: 'https', url: BASE_URL });
    expect(subject.capabilities).toEqual(CAPABILITIES);
    expect(subject.description).toContain('router');
    await collect(subject, HI);
    expect(http.requests[0]?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test('sends no credential when it has no key, whatever the environment holds', async () => {
    const before = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-ambient-key-that-must-not-leak';
    try {
      const http = replay(TEXT);
      await collect(llm(http, false), HI);
      expect(http.requests[0]?.headers.get('authorization')).toBe(null);
    } finally {
      if (before === undefined) {
        delete process.env['OPENAI_API_KEY'];
      } else {
        process.env['OPENAI_API_KEY'] = before;
      }
    }
  });
});

describe('openai-compatible provider: request mapping', () => {
  test('asks for a streamed completion that reports usage', async () => {
    const http = replay(TEXT);
    await collect(llm(http), { ...HI, effort: 'high', cacheKey: 'task-42' });
    expect(http.requests[0]?.body).toEqual({
      model: 'vendor/model-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Hi' }],
    });
  });

  test('maps system text and tool declarations', async () => {
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
        ...HI.messages,
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look an order up.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    });
    const body = http.requests[0]?.body;
    expect(body?.['messages']).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(body?.['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look an order up.',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    ]);
  });

  test('sends images as image_url parts, data as text, and leaves other files out', async () => {
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
              source: { kind: 'base64', data: 'cGRm' },
            },
            { type: 'data', mediaType: 'application/json', data: { total: 3 } },
          ],
        },
      ],
      tools: [],
    });
    expect(http.requests[0]?.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
          { type: 'image_url', image_url: { url: 'https://img.example/a.jpg' } },
          { type: 'text', text: '{"total":3}' },
        ],
      },
    ]);
  });

  test('sends an assistant turn with its tool calls, then the results in call order', async () => {
    const http = replay(TEXT);
    await collect(llm(http), {
      messages: [
        ...HI.messages,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', opaque: { provider: 'openai', data: { id: 'rs_1' } } },
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
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    source: { kind: 'base64', data: 'aGk=' },
                  },
                  { type: 'data', mediaType: 'application/json', data: { paid: true } },
                ],
              },
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Paid.' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', call: { id: 'call_c', name: 'rules', args: {} } }],
        },
      ],
      tools: [],
    });
    const call = (id: string, name: string, args: string): Json => ({
      id,
      type: 'function',
      function: { name, arguments: args },
    });
    expect(http.requests[0]?.body['messages']).toEqual([
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [call('call_a', 'lookup', '{"id":"A-1"}'), call('call_b', 'rules', '{}')],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'Order A-1\n{"paid":true}' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Error (timeout): too slow' },
      { role: 'assistant', content: 'Paid.' },
      { role: 'assistant', content: null, tool_calls: [call('call_c', 'rules', '{}')] },
    ]);
  });
});

describe('openai-compatible provider: response mapping', () => {
  test('reports usage including cached input tokens', async () => {
    const events = await collect(replaying(TEXT), HI);
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end',
      usage: { inputTokens: 88, outputTokens: 5, cachedInputTokens: 32 },
    });
  });

  test('assembles tool calls from deltas, by index', async () => {
    const events = await collect(
      replaying(sse(fixture('openai-compatible/parallel-tools.sse'))),
      HI,
    );
    expect(events).toEqual([
      {
        type: 'tool-call',
        call: { id: 'call_fixture_lookup', name: 'lookup', args: { id: 'A-1' } },
      },
      { type: 'tool-call', call: { id: 'call_fixture_rules', name: 'rules', args: {} } },
      {
        type: 'done',
        stopReason: 'tool-calls',
        usage: { inputTokens: 104, outputTokens: 34, cachedInputTokens: 0 },
      },
    ]);
  });

  test('gives a tool call without an id one, and reports zero usage when none is sent', async () => {
    const body = chatSse([
      chunk({ tool_calls: [{ index: 0, function: { name: 'rules', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { name: 'rules' } }] }),
      chunk({}, 'stop'),
    ]);
    const events = await collect(replaying(sse(body)), HI);
    expect(events).toEqual([
      { type: 'tool-call', call: { id: 'call_0', name: 'rules', args: {} } },
      { type: 'tool-call', call: { id: 'call_1', name: 'rules', args: {} } },
      {
        type: 'done',
        stopReason: 'tool-calls',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
    ]);
  });

  test('maps length, a content filter and a refusal to their stop reasons', async () => {
    const stop = async (...chunks: Record<string, Json>[]): Promise<string> => {
      const last = (await collect(replaying(sse(chatSse(chunks))), HI)).at(-1);
      return last?.type === 'done' ? last.stopReason : '';
    };
    expect(await stop(chunk({ content: 'Hel' }, 'length'))).toBe('length');
    expect(await stop(chunk({}, 'content_filter'))).toBe('refusal');
    expect(await stop(chunk({ refusal: 'No.' }), chunk({}, 'stop'))).toBe('refusal');
    const refused = await collect(
      replaying(sse(chatSse([chunk({ refusal: 'No.' }), chunk({}, 'stop')]))),
      HI,
    );
    expect(refused[0]).toEqual({ type: 'text.delta', text: 'No.' });
  });

  test('ends a stream that has no [DONE] marker once the endpoint closes it', async () => {
    const body = chatSse([chunk({ content: 'Hi' }), chunk({}, 'stop')], false);
    const events = await collect(replaying(sse(body)), HI);
    expect(events.map((event) => event.type)).toEqual(['text.delta', 'done']);
  });
});

describe('openai-compatible provider: errors', () => {
  async function llmError(subject: LLM): Promise<LlmError> {
    const error = await failure(subject, HI);
    if (!(error instanceof LlmError)) {
      throw new TypeError(`expected an LlmError, got ${String(error)}`);
    }
    return error;
  }

  test('maps HTTP statuses to retryable or fatal', async () => {
    const body = fixture('openai-compatible/error-401.json');
    const outcomes: Record<number, boolean> = {};
    for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 503]) {
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
      503: true,
    });
  });

  test('names the provider and model, and does not retry by itself', async () => {
    const http = replay(json(429, fixture('openai-compatible/error-429.json')));
    const error = await llmError(llm(http));
    expect(http.requests.length).toBe(1);
    expect(error.provider).toBe('router');
    expect(error.model).toBe('vendor/model-1');
    expect(error.message).toContain('429');
  });

  test('never puts the key, or an upstream body, in the error', async () => {
    const leaking = JSON.stringify({
      error: { message: `Incorrect API key provided: ${KEY}.`, code: KEY },
    });
    const error = await llmError(replaying(json(401, leaking)));
    expect(error.message.includes(KEY)).toBe(false);
    expect(error.message.includes('Incorrect API key')).toBe(false);
    const masked = await llmError(
      replaying(json(401, fixture('openai-compatible/error-401.json'))),
    );
    expect(masked.message.includes('sk-fixtu')).toBe(false);
  });

  test('a connection failure, and a keyless one, are retryable', async () => {
    expect((await llmError(replaying(new TypeError('fetch failed')))).retryable).toBe(true);
    const keyless = llm(replay(new TypeError('fetch failed')), false);
    expect((await llmError(keyless)).retryable).toBe(true);
  });

  test('an error reported inside the stream is an error', async () => {
    const body = chatSse([
      chunk({ content: 'Hel' }),
      { error: { code: 'server_error', message: 'upstream detail' } },
    ]);
    const error = await llmError(replaying(sse(body)));
    expect(error.retryable).toBe(true);
    expect(error.message.includes('upstream detail')).toBe(false);
  });

  test('a stream that ends without a finish reason is retryable', async () => {
    const error = await llmError(replaying(sse(chatSse([chunk({ content: 'Hel' })]))));
    expect(error.retryable).toBe(true);
  });

  test('tool arguments that are not JSON are a retryable error', async () => {
    const body = chatSse([
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    const error = await llmError(replaying(sse(body)));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('lookup');
  });

  test('aborting mid-answer ends the stream with a fatal error', async () => {
    const head = chatSse([chunk({ content: 'Hel' })], false);
    const subject = llm({ fetch: hanging(head), requests: [] });
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
