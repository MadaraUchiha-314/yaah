import type { LLM, LlmEvent, LlmRequest } from '../harness/models/llm/types.ts';
import { LlmError } from '../harness/models/llm/types.ts';
import type { ContractApi } from './contract-api.ts';

/**
 * How a test makes an implementation produce each situation the contract checks. For a
 * real provider this is done with recorded HTTP responses; no network is involved.
 */
export interface LlmContractSubject {
  /** A model that will answer with exactly the text `Hello, world.`. */
  text(): LLM;
  /** A model that will request `lookup({"id":"A-1"})` and `rules({})` in one response. */
  parallelTools(): LLM;
  /** A model whose provider fails with a rate limit or a server error. */
  retryableError(): LLM;
  /** A model whose provider rejects the request (bad request or authentication). */
  fatalError(): LLM;
}

const REQUEST: LlmRequest = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
  ],
  tools: [
    {
      name: 'lookup',
      description: 'Look an order up.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    { name: 'rules', description: 'Refund rules.', inputSchema: { type: 'object' } },
  ],
};

async function collect(llm: LLM): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of llm.stream(REQUEST, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

async function failure(llm: LLM): Promise<unknown> {
  try {
    await collect(llm);
  } catch (error) {
    return error;
  }
  return null;
}

function streamingContract(api: ContractApi, subject: LlmContractSubject): void {
  const { expect, test } = api;
  test('streams text as deltas that concatenate to the answer', async () => {
    const events = await collect(subject.text());
    const text = events.map((event) => (event.type === 'text.delta' ? event.text : '')).join('');
    expect(text).toBe('Hello, world.');
  });

  test('ends with exactly one done event, last, with non-negative usage', async () => {
    const events = await collect(subject.text());
    const last = events.at(-1);
    expect(events.filter((event) => event.type === 'done').length).toBe(1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.stopReason).toBe('end');
      expect(last.usage.inputTokens >= 0 && last.usage.outputTokens >= 0).toBe(true);
    }
  });

  test('reports several tool calls from one response, with parsed arguments', async () => {
    const events = await collect(subject.parallelTools());
    const calls = events.flatMap((event) => (event.type === 'tool-call' ? [event.call] : []));
    expect(calls.map((toolCall) => toolCall.name)).toEqual(['lookup', 'rules']);
    expect(calls[0]?.args).toEqual({ id: 'A-1' });
    expect(calls[1]?.args).toEqual({});
    expect(new Set(calls.map((toolCall) => toolCall.id)).size).toBe(2);
    const last = events.at(-1);
    expect(last?.type === 'done' ? last.stopReason : '').toBe('tool-calls');
  });
}

function errorContract(api: ContractApi, subject: LlmContractSubject): void {
  const { expect, test } = api;
  test('a rate limit or server error is an LlmError marked retryable', async () => {
    const llm = subject.retryableError();
    const error = await failure(llm);
    expect(error instanceof LlmError).toBe(true);
    if (error instanceof LlmError) {
      expect(error.retryable).toBe(true);
      expect(error.model.length > 0 && error.provider.length > 0).toBe(true);
    }
  });

  test('a rejected request is an LlmError marked not retryable', async () => {
    const error = await failure(subject.fatalError());
    expect(error instanceof LlmError).toBe(true);
    if (error instanceof LlmError) {
      expect(error.retryable).toBe(false);
    }
  });

  test('an aborted signal stops the stream', async () => {
    const controller = new AbortController();
    controller.abort();
    let finished = false;
    try {
      for await (const event of subject.text().stream(REQUEST, controller.signal)) {
        expect(event.type === 'done').toBe(false);
      }
      finished = true;
    } catch {
      finished = true;
    }
    expect(finished).toBe(true);
  });
}

/**
 * The contract every `llm` entity must keep. Run it against a provider of your own
 * before registering it.
 */
export function llmContract(api: ContractApi, name: string, subject: LlmContractSubject): void {
  api.describe(`llm contract: ${name}`, () => {
    api.test('declares its address, locality and capabilities', () => {
      const llm = subject.text();
      api.expect(llm.ref.kind).toBe('llm');
      api.expect(llm.capabilities.contextWindow > 0).toBe(true);
      api.expect(llm.capabilities.maxOutput > 0).toBe(true);
    });
    streamingContract(api, subject);
    errorContract(api, subject);
  });
}
