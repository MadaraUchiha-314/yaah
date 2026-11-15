import { describe, expect, test } from 'bun:test';

import {
  anthropic,
  answer,
  collect,
  failure,
  replay,
  sse,
} from '../../../../../test/support/anthropic.ts';
import type { Replay } from '../../../../../test/support/anthropic.ts';
import type { LlmContent, LlmMessage, LlmRequest } from '../types.ts';
import { LlmError } from '../types.ts';

const EPHEMERAL = { type: 'ephemeral' };

function text(value: string): Extract<LlmContent, { type: 'text' }> {
  return { type: 'text', text: value };
}

function user(value: string, cacheBoundary = false): LlmMessage {
  return { role: 'user', content: [text(value)], cacheBoundary };
}

function toolResult(callId: string, value: string): LlmMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', callId, result: { ok: true, content: [text(value)] } }],
  };
}

/** Sends `request` to a fake API and returns the JSON body it received. */
async function bodyOf(request: Partial<LlmRequest>, model?: string): Promise<unknown> {
  const fake: Replay = replay(sse(answer('end_turn')));
  await collect(anthropic(fake, model), { messages: [], tools: [], ...request });
  expect(fake.bodies.length).toBe(1);
  return fake.bodies[0];
}

describe('anthropic request mapping', () => {
  test('streams from the Messages API with the model, its output limit and no forced tool', async () => {
    const fake = replay(sse(answer('end_turn')));
    await collect(anthropic(fake), { messages: [user('Hi')], tools: [] });
    expect(fake.urls).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(fake.bodies[0]).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 128_000,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });
  });

  test('an unknown model gets the conservative output limit and never an effort', async () => {
    const body = await bodyOf({ messages: [user('Hi')], effort: 'high' }, 'claude-next');
    expect(body).toMatchObject({ model: 'claude-next', max_tokens: 16_384 });
    expect(body).not.toHaveProperty('output_config');
  });

  test('system messages go to the top-level system parameter, one block per text', async () => {
    const body = await bodyOf({
      messages: [
        { role: 'system', content: [text('Be brief.'), text('')] },
        user('Hi'),
        { role: 'system', content: [text('Be kind.')] },
      ],
    });
    expect(body).toMatchObject({
      system: [
        { type: 'text', text: 'Be brief.' },
        { type: 'text', text: 'Be kind.' },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });
  });

  test('tools are declared with input_schema', async () => {
    const body = await bodyOf({
      messages: [user('Hi')],
      tools: [
        {
          name: 'lookup',
          description: 'Look an order up.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      ],
    });
    expect(body).toMatchObject({
      tools: [
        {
          name: 'lookup',
          description: 'Look an order up.',
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ],
    });
    expect(body).not.toHaveProperty('tool_choice');
  });

  test('effort becomes output_config.effort', async () => {
    expect(await bodyOf({ messages: [user('Hi')], effort: 'xhigh' })).toMatchObject({
      output_config: { effort: 'xhigh' },
    });
    expect(await bodyOf({ messages: [user('Hi')], effort: 'turbo' })).not.toHaveProperty(
      'output_config',
    );
  });

  test('the results of one turn travel in one user message, in the order of the calls', async () => {
    const body = await bodyOf({
      messages: [
        user('Go'),
        {
          role: 'assistant',
          content: [
            text('Looking.'),
            { type: 'tool-call', call: { id: 'c1', name: 'lookup', args: { id: 'A-1' } } },
            { type: 'tool-call', call: { id: 'c2', name: 'rules', args: null } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              callId: 'c2',
              result: { ok: false, error: { code: 'timeout', message: 'too slow' } },
            },
          ],
        },
        toolResult('zz', 'stray'),
        toolResult('c1', 'Delivered.'),
        user('And now?'),
      ],
    });
    expect(body).toMatchObject({
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'c1', name: 'lookup', input: { id: 'A-1' } },
            { type: 'tool_use', id: 'c2', name: 'rules', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'c1',
              content: [{ type: 'text', text: 'Delivered.' }],
            },
            {
              type: 'tool_result',
              tool_use_id: 'c2',
              is_error: true,
              content: [{ type: 'text', text: 'timeout: too slow' }],
            },
            { type: 'tool_result', tool_use_id: 'zz' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
      ],
    });
  });

  test('a result with no content sends its structured value, or nothing', async () => {
    const body = await bodyOf({
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              callId: 'c1',
              result: { ok: true, content: [], structured: [1] },
            },
            { type: 'tool-result', callId: 'c2', result: { ok: true, content: [] } },
            text('note'),
          ],
        },
      ],
    });
    expect(body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '[1]' }] },
            { type: 'tool_result', tool_use_id: 'c2' },
            { type: 'text', text: 'note' },
          ],
        },
      ],
    });
  });

  test('thinking blocks are replayed unchanged and in place; foreign reasoning is dropped', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig==', extra: { kept: true } };
    const redacted = { type: 'redacted_thinking', data: 'opaque==' };
    const body = await bodyOf({
      messages: [
        user('Go'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', opaque: { provider: 'anthropic', data: thinking } },
            text('One moment.'),
            { type: 'reasoning', opaque: { provider: 'anthropic', data: redacted } },
            { type: 'reasoning', opaque: { provider: 'openai', data: { id: 'rs_1' } } },
            { type: 'reasoning', opaque: { provider: 'anthropic', data: 'not a block' } },
            { type: 'reasoning', opaque: { provider: 'anthropic', data: { type: 'other' } } },
            { type: 'tool-call', call: { id: 'c1', name: 'rules', args: {} } },
          ],
        },
        // An assistant turn of nothing sendable is left out altogether.
        {
          role: 'assistant',
          content: [{ type: 'reasoning', opaque: { provider: 'openai', data: {} } }],
        },
      ],
    });
    expect(body).toMatchObject({
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            thinking,
            { type: 'text', text: 'One moment.' },
            redacted,
            { type: 'tool_use', id: 'c1', name: 'rules', input: {} },
          ],
        },
      ],
    });
  });

  test('images are sent by URL or as base64; data parts as JSON text', async () => {
    const body = await bodyOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'image/png', source: { kind: 'base64', data: 'AAAA' } },
            {
              type: 'file',
              mediaType: 'image/*',
              source: { kind: 'url', url: 'https://example.com/a.png' },
            },
            { type: 'data', mediaType: 'application/json', data: { a: 1 } },
          ],
        },
      ],
    });
    expect(body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
            { type: 'text', text: '{"a":1}' },
          ],
        },
      ],
    });
  });

  test('a file the API cannot take fails before any request, not retryable', async () => {
    const fake = replay(sse(answer('end_turn')));
    const sources = [
      { mediaType: 'audio/wav', source: { kind: 'base64', data: 'AAAA' } },
      { mediaType: 'image/tiff', source: { kind: 'base64', data: 'AAAA' } },
      { mediaType: 'application/pdf', source: { kind: 'url', url: 'https://example.com/a.pdf' } },
    ] as const;
    for (const source of sources) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
      const error = await failure(anthropic(fake), {
        messages: [{ role: 'user', content: [{ type: 'file', ...source }] }],
        tools: [],
      });
      expect(error).toBeInstanceOf(LlmError);
      expect(error instanceof LlmError && error.retryable).toBe(false);
      expect(error instanceof LlmError ? error.message : '').toContain(source.mediaType);
    }
    expect(fake.bodies.length).toBe(0);
  });
});

describe('anthropic prompt caching', () => {
  test('a cache boundary marks the last block of its message', async () => {
    const body = await bodyOf({
      messages: [
        { role: 'system', content: [text('A'), text('B')], cacheBoundary: true },
        { role: 'user', content: [text('one'), text('two')], cacheBoundary: true },
        user('three'),
      ],
    });
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 128_000,
      stream: true,
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B', cache_control: EPHEMERAL },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two', cache_control: EPHEMERAL },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'three' }] },
      ],
    });
  });

  test('only the last four boundaries are kept', async () => {
    const body = await bodyOf({
      messages: [
        { role: 'system', content: [text('S')], cacheBoundary: true },
        user('1', true),
        user('2', true),
        user('3', true),
        user('4', true),
      ],
    });
    expect(JSON.stringify(body).split('"cache_control"').length - 1).toBe(4);
    expect(body).toMatchObject({ system: [{ type: 'text', text: 'S' }] });
    expect(body).not.toMatchObject({ system: [{ cache_control: EPHEMERAL }] });
  });

  test('a boundary on a merged tool message stays on that message; thinking is never marked', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig==' };
    const body = await bodyOf({
      messages: [
        user('Go'),
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', call: { id: 'c1', name: 'a', args: {} } },
            { type: 'tool-call', call: { id: 'c2', name: 'b', args: {} } },
            { type: 'reasoning', opaque: { provider: 'anthropic', data: thinking } },
          ],
          cacheBoundary: true,
        },
        { ...toolResult('c1', 'first'), cacheBoundary: true },
        toolResult('c2', 'second'),
        {
          role: 'assistant',
          content: [{ type: 'reasoning', opaque: { provider: 'anthropic', data: thinking } }],
          cacheBoundary: true,
        },
      ],
    });
    expect(body).toMatchObject({
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'c1' },
            { type: 'tool_use', id: 'c2', cache_control: EPHEMERAL },
            thinking,
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', cache_control: EPHEMERAL },
            { type: 'tool_result', tool_use_id: 'c2' },
          ],
        },
        { role: 'assistant', content: [thinking] },
      ],
    });
    expect(JSON.stringify(body).split('"cache_control"').length - 1).toBe(2);
  });
});
