import { describe, expect, test } from 'bun:test';

import type { LlmEvent } from '../../src/harness/models/llm/types.ts';
import { LlmError } from '../../src/harness/models/llm/types.ts';
import { llmContract } from '../../src/testing/llm-contract.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';

llmContract({ describe, expect, test }, 'scripted', {
  text: () => new ScriptedLlm([say('Hello, world.')]),
  parallelTools: () =>
    new ScriptedLlm([callTools(call('c1', 'lookup', { id: 'A-1' }), call('c2', 'rules'))]),
  retryableError: () =>
    new ScriptedLlm([{ error: new LlmError('scripted', 'scripted/model', true, 'rate limited') }]),
  fatalError: () =>
    new ScriptedLlm([{ error: new LlmError('scripted', 'scripted/model', false, 'bad request') }]),
});

describe('ScriptedLlm', () => {
  test('records the requests it received and counts remaining turns', async () => {
    const llm = new ScriptedLlm([
      say('one'),
      (request): readonly LlmEvent[] => say(String(request.messages.length)),
    ]);
    const request = { messages: [], tools: [] };
    for await (const event of llm.stream(request, new AbortController().signal)) {
      expect(event.type).toBeDefined();
    }
    expect(llm.requests).toEqual([request]);
    expect(llm.remaining).toBe(1);
  });

  test('fails clearly when the script runs out', async () => {
    const llm = new ScriptedLlm([]);
    const drain = async (): Promise<void> => {
      for await (const event of llm.stream(
        { messages: [], tools: [] },
        new AbortController().signal,
      )) {
        expect(event).toBeDefined();
      }
    };
    let message = '';
    try {
      await drain();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('no more turns');
  });

  test('reports configured usage on done', async () => {
    const llm = new ScriptedLlm([say('x')], { usagePerCall: { inputTokens: 10, outputTokens: 2 } });
    const events = [];
    for await (const event of llm.stream(
      { messages: [], tools: [] },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
    });
  });
});
