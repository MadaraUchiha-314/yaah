import { describe, expect, test } from 'bun:test';

import {
  TEST_KEY,
  anthropic,
  answer,
  collect,
  failure,
  fixture,
  replay,
  sse,
} from '../../../../../test/support/anthropic.ts';
import type { FakeEvent } from '../../../../../test/support/anthropic.ts';
import type { LlmEvent, LlmRequest } from '../types.ts';
import { LlmError } from '../types.ts';
import type { AnthropicFetch } from './index.ts';
import { anthropicCapabilities, createAnthropicLlm } from './index.ts';

const REQUEST: LlmRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [],
};

const START: FakeEvent = {
  type: 'message_start',
  message: { usage: { input_tokens: 10, output_tokens: 1 } },
};

function done(events: readonly LlmEvent[]): LlmEvent | undefined {
  return events.at(-1);
}

async function errorOf(body: string, status: number): Promise<LlmError> {
  const error = await failure(anthropic(replay(body, status)), REQUEST);
  if (!(error instanceof LlmError)) {
    throw new TypeError('expected an LlmError');
  }
  return error;
}

describe('anthropic entity', () => {
  test('is addressed as anthropic/<model> and is remote over https', () => {
    const llm = anthropic(replay(''), 'claude-opus-5-5');
    expect(llm.ref).toEqual({ kind: 'llm', id: 'anthropic/claude-opus-5-5', version: null });
    expect(llm.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://api.anthropic.com',
    });
    expect(llm.description).toContain('claude-opus-5-5');
  });

  test('knows the Claude 5 models and is conservative about the rest', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
    ]) {
      expect(anthropicCapabilities(model)).toEqual({
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        input: ['image'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
    }
    expect(anthropicCapabilities('claude-next')).toEqual({
      contextWindow: 200_000,
      maxOutput: 16_384,
      input: ['image'],
      efforts: [],
    });
    const custom = { contextWindow: 1, maxOutput: 2, input: [], efforts: [] };
    const llm = createAnthropicLlm({ model: 'm', apiKey: TEST_KEY, capabilities: custom });
    expect(llm.capabilities).toBe(custom);
  });

  test('sends the key only in the authorization header', async () => {
    const fake = replay(sse(answer('end_turn')));
    await collect(anthropic(fake), REQUEST);
    expect(fake.headers[0]?.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(fake.urls.join(' ')).not.toContain(TEST_KEY);
    expect(JSON.stringify(fake.bodies)).not.toContain(TEST_KEY);
  });
});

describe('anthropic usage and stop reasons', () => {
  test('counts the whole prompt as input and cache reads as cached', async () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 7,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    const events = await collect(anthropic(replay(sse(answer('end_turn', usage)))), REQUEST);
    expect(done(events)).toEqual({
      type: 'done',
      stopReason: 'end',
      usage: { inputTokens: 130, outputTokens: 7, cachedInputTokens: 100 },
    });
  });

  test('keeps the input count of message_start when message_delta has none', async () => {
    const events = await collect(anthropic(replay(sse(answer('end_turn')))), REQUEST);
    expect(done(events)).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 },
    });
  });

  test('maps every stop reason', async () => {
    const expected = {
      end_turn: 'end',
      stop_sequence: 'end',
      pause_turn: 'end',
      tool_use: 'tool-calls',
      max_tokens: 'length',
      model_context_window_exceeded: 'length',
      refusal: 'refusal',
    };
    for (const [reason, stopReason] of Object.entries(expected)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
      const events = await collect(anthropic(replay(sse(answer(reason)))), REQUEST);
      expect(done(events)).toMatchObject({ type: 'done', stopReason });
    }
  });

  test('emits redacted thinking as it came and drops a tool call cut off mid-JSON', async () => {
    const redacted = { type: 'redacted_thinking', data: 'opaque==' };
    const body = sse([
      START,
      { type: 'content_block_start', index: 0, content_block: redacted },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id": "A' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]);
    const events = await collect(anthropic(replay(body)), REQUEST);
    expect(events).toEqual([
      { type: 'reasoning', opaque: { provider: 'anthropic', data: redacted } },
      {
        type: 'done',
        stopReason: 'length',
        usage: { inputTokens: 10, outputTokens: 9, cachedInputTokens: 0 },
      },
    ]);
  });

  test('assembles a streamed thinking block and nested tool arguments', async () => {
    const body = sse([
      START,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'm.' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 's=' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'c1', name: 'f', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"a": [1, true, null, {"b": "c"}]}' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]);
    const events = await collect(anthropic(replay(body)), REQUEST);
    expect(events.slice(0, 2)).toEqual([
      {
        type: 'reasoning',
        opaque: {
          provider: 'anthropic',
          data: { type: 'thinking', thinking: 'Hmm.', signature: 's=' },
        },
      },
      {
        type: 'tool-call',
        call: { id: 'c1', name: 'f', args: { a: [1, true, null, { b: 'c' }] } },
      },
    ]);
  });
});

describe('anthropic errors', () => {
  test('rate limits, overload and server errors are retryable', async () => {
    const cases = [
      [fixture('handwritten/error-429.json'), 429],
      [fixture('handwritten/error-529.json'), 529],
      ['{"type":"error","error":{"type":"api_error","message":"Internal"}}', 500],
      ['{"type":"error","error":{"type":"timeout_error","message":"Slow"}}', 408],
      ['{"type":"error","error":{"type":"conflict_error","message":"Busy"}}', 409],
      ['<html>bad gateway</html>', 502],
    ] as const;
    for (const [body, status] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
      const error = await errorOf(body, status);
      expect(error.retryable).toBe(true);
      expect(error.code).toBe('llm.retryable');
      expect(error.message).toContain(String(status));
      expect(error.provider).toBe('anthropic');
      expect(error.model).toBe('claude-haiku-5-5');
    }
  });

  test('rejected requests are not retryable', async () => {
    const reject = (type: string): string =>
      JSON.stringify({ type: 'error', error: { type, message: 'no' } });
    const cases = [
      [fixture('handwritten/error-400.json'), 400],
      [fixture('handwritten/error-401.json'), 401],
      [reject('permission_error'), 403],
      [reject('not_found_error'), 404],
      [reject('request_too_large'), 413],
      [reject('invalid_request_error'), 422],
    ] as const;
    for (const [body, status] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
      const error = await errorOf(body, status);
      expect(error.retryable).toBe(false);
      expect(error.code).toBe('llm.fatal');
    }
    const bad = await errorOf(fixture('handwritten/error-400.json'), 400);
    expect(bad.message).toContain('at least one message is required');
    expect(bad.message).toContain('invalid_request_error');
  });

  test('makes one attempt: the SDK does not retry on its own', async () => {
    const fake = replay(fixture('handwritten/error-529.json'), 529);
    await failure(anthropic(fake), REQUEST);
    expect(fake.bodies.length).toBe(1);
  });

  test('a connection failure is retryable', async () => {
    const broken: AnthropicFetch = () => Promise.reject(new TypeError('fetch failed'));
    const llm = createAnthropicLlm({ model: 'claude-haiku-5-5', apiKey: TEST_KEY, fetch: broken });
    const error = await failure(llm, REQUEST);
    expect(error instanceof LlmError && error.retryable).toBe(true);
  });

  test('an error event in the stream is classified by its type', async () => {
    const midStream = (type: string): string =>
      `${sse([START])}event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: 'mid-stream' } })}\n\n`;
    const overloaded = await errorOf(midStream('overloaded_error'), 200);
    expect(overloaded.retryable).toBe(true);
    expect(overloaded.message).toContain('overloaded_error');
    const invalid = await errorOf(midStream('invalid_request_error'), 200);
    expect(invalid.retryable).toBe(false);
  });

  test('a stream that ends early, or cannot be read, is retryable', async () => {
    const cut = await errorOf(sse(answer('end_turn').slice(0, 3)), 200);
    expect(cut.retryable).toBe(true);
    const garbled = await errorOf('event: message_start\ndata: {not json\n\n', 200);
    expect(garbled.retryable).toBe(true);
  });

  test('the key never appears in an error, even when the API echoes it', async () => {
    const echo = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: `invalid x-api-key ${TEST_KEY}` },
    });
    const errors = [
      await errorOf(echo, 401),
      await errorOf(fixture('handwritten/error-401.json'), 401),
      await errorOf(fixture('handwritten/error-429.json'), 429),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain(TEST_KEY);
      expect(String(error.cause)).not.toContain(TEST_KEY);
    }
    expect(errors[0]?.message).toContain('[redacted]');
    expect(errors[0]?.cause).toBeUndefined();
    expect(errors[1]?.cause).toBeDefined();
  });

  test('an empty key is not treated as a secret to scrub', async () => {
    const fake = replay(fixture('handwritten/error-400.json'), 400);
    const llm = createAnthropicLlm({ model: 'm', apiKey: '', fetch: fake.fetch });
    const error = await failure(llm, REQUEST);
    expect(error instanceof LlmError ? error.message : '').toContain('at least one message');
  });
});

describe('anthropic abort', () => {
  test('passes the signal on, and an abort before the call is not retryable', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = replay(sse(answer('end_turn')));
    let caught: unknown = null;
    try {
      for await (const event of anthropic(fake).stream(REQUEST, controller.signal)) {
        expect(event).toBeUndefined();
      }
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof LlmError && !caught.retryable).toBe(true);
    expect(fake.bodies.length).toBe(0);
  });

  test('an abort while streaming ends the stream with a non-retryable error', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const hanging: AnthropicFetch = (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream): void {
          stream.enqueue(encoder.encode(sse(answer('end_turn').slice(0, 3))));
          init?.signal?.addEventListener('abort', () => {
            stream.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    };
    const llm = createAnthropicLlm({ model: 'claude-haiku-5-5', apiKey: TEST_KEY, fetch: hanging });
    const seen: string[] = [];
    let caught: unknown = null;
    try {
      for await (const event of llm.stream(REQUEST, controller.signal)) {
        seen.push(event.type);
        controller.abort();
      }
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual(['text.delta']);
    expect(caught instanceof LlmError && !caught.retryable).toBe(true);
  });
});
