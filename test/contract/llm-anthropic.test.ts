/**
 * The `llm` contract against the Anthropic provider, with HTTP responses replayed through
 * the SDK's `fetch` option. The stream bodies are recordings of the real Messages API
 * (`scripts/record-anthropic-fixtures.ts`); the error bodies under `handwritten/` are
 * written by hand from the API's documented error shape.
 */
import { describe, expect, test } from 'bun:test';

import { llmContract } from '../../src/testing/llm-contract.ts';
import { anthropic, collect, fixture, replay } from '../support/anthropic.ts';

llmContract({ describe, expect, test }, 'anthropic', {
  text: () => anthropic(replay(fixture('text.sse'))),
  parallelTools: () => anthropic(replay(fixture('parallel-tools.sse'))),
  retryableError: () => anthropic(replay(fixture('handwritten/error-429.json'), 429)),
  fatalError: () => anthropic(replay(fixture('handwritten/error-400.json'), 400)),
});

describe('anthropic recordings', () => {
  test('a recorded thinking block is emitted whole, before the tool call it led to', async () => {
    const events = await collect(anthropic(replay(fixture('thinking.sse'))), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [],
    });
    expect(events.map((event) => event.type)).toEqual(['reasoning', 'tool-call', 'done']);
    const [reasoning] = events;
    const data = reasoning?.type === 'reasoning' ? reasoning.opaque.data : null;
    expect(data).toMatchObject({ type: 'thinking', thinking: '' });
    expect(JSON.stringify(data)).toContain('"signature":"');
    expect(reasoning?.type === 'reasoning' ? reasoning.opaque.provider : '').toBe('anthropic');
  });

  test('the recorded follow-up turns end normally', async () => {
    for (const name of ['tool-followup.sse', 'thinking-followup.sse', 'image.sse']) {
      // oxlint-disable-next-line no-await-in-loop -- three tiny sequential replays
      const events = await collect(anthropic(replay(fixture(name))), { messages: [], tools: [] });
      expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' });
      expect(events.some((event) => event.type === 'text.delta')).toBe(true);
    }
  });
});
