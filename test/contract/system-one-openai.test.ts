/**
 * The OpenAI System One provider (Decisions API) against the `system-one` contract and
 * its own mapping rules. Every HTTP response is replayed through the SDK's `fetch`
 * option. The fixtures under `test/fixtures/system-one/openai/` are hand-written from the
 * documented shape of the API — see the README there; none is a recording.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createOpenAiSystemOne } from '../../src/harness/models/system-one/openai/provider.ts';
import type { Question, SystemOne } from '../../src/harness/models/system-one/types.ts';
import { SystemOneError } from '../../src/harness/models/system-one/types.ts';
import {
  SYSTEM_ONE_CONTRACT_INPUT,
  SYSTEM_ONE_CONTRACT_QUESTIONS,
  systemOneContract,
} from '../../src/testing/system-one-contract.ts';
import type { Replay, Scripted } from '../support/llm-http.ts';
import { json, replay } from '../support/llm-http.ts';

const KEY = 'sk-fixture-secret-key-0001';
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'system-one', 'openai');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function model(http: Replay): SystemOne {
  return createOpenAiSystemOne({ apiKey: KEY, fetch: http.fetch });
}

function replaying(...responses: readonly Scripted[]): SystemOne {
  return model(replay(...responses));
}

const DECISION = json(200, fixture('decision.json'));
const INPUT = { text: SYSTEM_ONE_CONTRACT_INPUT };
const live = (): AbortSignal => new AbortController().signal;

async function failure(
  subject: SystemOne,
  questions: readonly Question[] = SYSTEM_ONE_CONTRACT_QUESTIONS,
  signal: AbortSignal = live(),
): Promise<unknown> {
  try {
    await subject.decide(INPUT, questions, signal);
  } catch (error) {
    return error;
  }
  return null;
}

/** A 200 response whose answers are `answers`. */
function answering(answers: unknown): () => Response {
  return json(200, JSON.stringify({ model: 'gpt-6-luna', answers, usage: {} }));
}

systemOneContract({ describe, expect, test }, 'openai', {
  answers: () => replaying(DECISION),
  retryableError: () => replaying(json(429, fixture('error-429.json'))),
  fatalError: () => replaying(json(400, fixture('error-400.json'))),
});

describe('openai system one: entity and request', () => {
  test('is addressed as openai/gpt-6-luna by default and reached over https', () => {
    const subject = replaying(DECISION);
    expect(subject.ref).toEqual({ kind: 'system-one', id: 'openai/gpt-6-luna', version: null });
    expect(subject.locality).toEqual({
      type: 'remote',
      protocol: 'https',
      url: 'https://api.openai.com/v1',
    });
    expect(subject.description).toContain('gpt-6-luna');
  });

  test('posts one request to /decisions with the key as a bearer token', async () => {
    const http = replay(DECISION);
    const subject = createOpenAiSystemOne({
      model: 'gpt-6-luna-next',
      apiKey: KEY,
      baseUrl: 'https://proxy.example/v1',
      fetch: http.fetch,
    });
    await subject.decide(INPUT, SYSTEM_ONE_CONTRACT_QUESTIONS, live());
    expect(subject.ref.id).toBe('openai/gpt-6-luna-next');
    expect(http.requests.length).toBe(1);
    expect(http.requests[0]?.url).toBe('https://proxy.example/v1/decisions');
    expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(http.requests[0]?.body['model']).toBe('gpt-6-luna-next');
  });

  test('sends the input as text and each question by type, named by its id', async () => {
    const http = replay(DECISION);
    await model(http).decide(INPUT, SYSTEM_ONE_CONTRACT_QUESTIONS, live());
    expect(http.requests[0]?.body).toEqual({
      model: 'gpt-6-luna',
      input: 'The package arrived with a broken screen.',
      questions: [
        {
          type: 'predicate',
          name: 'damaged',
          instructions: 'Does the customer report a damaged item?',
        },
        {
          type: 'choice',
          name: 'topic',
          instructions: 'What is the message about?',
          choices: [
            { value: 'billing' },
            { value: 'shipping', description: 'Delivery, or the state the item arrived in.' },
            { value: 'other' },
          ],
        },
        {
          type: 'score',
          name: 'severity',
          instructions: 'How severe is the problem?',
          levels: [{ label: 'Cosmetic' }, { label: 'Degraded' }, { label: 'Unusable' }],
        },
      ],
    });
  });

  test('sends the description of a score level', async () => {
    const http = replay(answering([{ type: 'score', name: 'q', score: 0, confidence: 1 }]));
    const levels = [{ label: 'Low', description: 'Barely.' }, { label: 'High' }];
    await model(http).decide(
      INPUT,
      [{ type: 'score', id: 'q', text: 'How much?', levels }],
      live(),
    );
    expect(http.requests[0]?.body['questions']).toEqual([
      { type: 'score', name: 'q', instructions: 'How much?', levels },
    ]);
  });
});

describe('openai system one: response mapping', () => {
  test('maps each answer to its question: probability, choice and score', async () => {
    const answers = await replaying(DECISION).decide(INPUT, SYSTEM_ONE_CONTRACT_QUESTIONS, live());
    expect(answers).toEqual([
      { type: 'predicate', id: 'damaged', probability: 0.95 },
      { type: 'choice', id: 'topic', choice: 'shipping', confidence: 0.91 },
      { type: 'score', id: 'severity', score: 1.1, confidence: 0.55 },
    ]);
  });

  test('a refused question is a refusal; the others keep their answers', async () => {
    const subject = replaying(json(200, fixture('refusal.json')));
    const answers = await subject.decide(INPUT, SYSTEM_ONE_CONTRACT_QUESTIONS, live());
    expect(answers.map((answer) => answer.type)).toEqual(['predicate', 'refusal', 'score']);
    expect(answers[1]).toEqual({
      type: 'refusal',
      id: 'topic',
      reason: 'The model declined to answer this question.',
    });
  });

  test('answers that do not line up with the questions are a retryable error', async () => {
    const predicate = { type: 'predicate', name: 'damaged', probability: 0.9 };
    const misaligned: readonly unknown[] = [
      [predicate],
      [predicate, predicate, predicate],
      [predicate, { type: 'choice', name: 'topic', choice: 'refunds', confidence: 1 }, predicate],
      [predicate, { type: 'choice', name: 'topic', choice: true, confidence: 1 }, predicate],
      'not a list',
    ];
    const errors = await Promise.all(
      misaligned.map((answers) => failure(replaying(answering(answers)))),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(SystemOneError);
      expect(error instanceof SystemOneError && error.retryable).toBe(true);
      expect(error instanceof SystemOneError && error.code).toBe('system-one.retryable');
      expect(error instanceof Error ? error.message : '').toBe(
        'The answers of model gpt-6-luna from openai do not match the questions asked.',
      );
    }
  });
});

describe('openai system one: failures', () => {
  test('maps HTTP statuses to retryable or fatal without echoing the response', async () => {
    const body = JSON.stringify({ error: { message: `bad key ${KEY}`, code: 'invalid_api_key' } });
    const fatal = await failure(replaying(json(401, body)));
    expect(fatal instanceof SystemOneError && fatal.retryable).toBe(false);
    expect(fatal instanceof SystemOneError && fatal.provider).toBe('openai');
    expect(fatal instanceof SystemOneError && fatal.model).toBe('gpt-6-luna');
    expect(fatal instanceof Error ? fatal.message : '').toContain('HTTP 401 (invalid_api_key)');
    expect(fatal instanceof Error ? fatal.message : KEY).not.toContain(KEY);
    const server = await failure(replaying(json(503, '{}')));
    expect(server instanceof SystemOneError && server.retryable).toBe(true);
  });

  test('a connection failure is retryable', async () => {
    const error = await failure(replaying(new TypeError('fetch failed')));
    expect(error instanceof SystemOneError && error.retryable).toBe(true);
  });

  test('does not retry by itself', async () => {
    const http = replay(json(429, fixture('error-429.json')));
    await failure(model(http));
    expect(http.requests.length).toBe(1);
  });

  test('an abort during the request rejects with a fatal error and sends nothing more', async () => {
    const controller = new AbortController();
    const hanging: Replay['fetch'] = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const subject = createOpenAiSystemOne({ apiKey: KEY, fetch: hanging });
    const pending = failure(subject, SYSTEM_ONE_CONTRACT_QUESTIONS, controller.signal);
    controller.abort();
    const error = await pending;
    expect(error instanceof SystemOneError && error.retryable).toBe(false);
    expect(error instanceof Error ? error.message : '').toContain('cancelled');
  });
});
