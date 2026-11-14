/**
 * Records the Anthropic stream fixtures the contract tests replay.
 *
 * Calls the real Messages API through the provider itself and writes each response body,
 * byte for byte, to `test/fixtures/llm/anthropic/<name>.sse`. Only response bodies are
 * written: no request, no header, no key. Tests never run this; it costs a fraction of a
 * cent per run.
 *
 *   ANTHROPIC_API_KEY=… bun run scripts/record-anthropic-fixtures.ts [model]
 *
 * The model defaults to `claude-haiku-5-5`. Check the printed events before committing:
 * `text` must be exactly `Hello, world.` and `parallel-tools` must call `lookup` then
 * `rules`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AnthropicFetch } from '../src/harness/models/llm/anthropic/index.ts';
import { createAnthropicLlm } from '../src/harness/models/llm/anthropic/index.ts';
import type {
  LlmContent,
  LlmEvent,
  LlmMessage,
  LlmRequest,
  ToolDeclaration,
} from '../src/harness/models/llm/types.ts';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'llm', 'anthropic');
/** A 1×1 red PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const TOOLS: readonly ToolDeclaration[] = [
  {
    name: 'lookup',
    description: 'Look an order up.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  { name: 'rules', description: 'Refund rules.', inputSchema: { type: 'object' } },
];

const SYSTEM: LlmMessage = {
  role: 'system',
  content: [{ type: 'text', text: 'Be brief.' }],
  cacheBoundary: true,
};

function user(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

async function record(name: string, model: string, request: LlmRequest): Promise<LlmEvent[]> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const recordingFetch: AnthropicFetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = await response.text();
    if (response.ok) {
      await writeFile(join(DIR, `${name}.sse`), body);
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const llm = createAnthropicLlm({ model, apiKey, fetch: recordingFetch });
  const events: LlmEvent[] = [];
  for await (const event of llm.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  console.log(`\n== ${name}`);
  for (const event of events) {
    console.log(JSON.stringify(event).slice(0, 200));
  }
  return events;
}

/** The assistant turn `events` describe, as it is sent back on the next request. */
function assistantTurn(events: readonly LlmEvent[]): LlmMessage {
  const content: LlmContent[] = [];
  const text = events.map((event) => (event.type === 'text.delta' ? event.text : '')).join('');
  for (const event of events) {
    if (event.type === 'reasoning' || event.type === 'tool-call') {
      content.push(event);
    }
  }
  if (text !== '') {
    content.push({ type: 'text', text });
  }
  return { role: 'assistant', content };
}

async function main(): Promise<void> {
  const model = process.argv[2] ?? 'claude-haiku-5-5';
  await mkdir(DIR, { recursive: true });
  await record('text', model, {
    messages: [SYSTEM, user('Reply with exactly this and nothing else: Hello, world.')],
    tools: TOOLS,
    effort: 'low',
  });
  const ask = user(
    'Order A-1: call lookup with id "A-1" and call rules, both in this one response, lookup first.',
  );
  const calls = await record('parallel-tools', model, {
    messages: [SYSTEM, ask],
    tools: TOOLS,
    effort: 'low',
  });
  // The results arrive out of order and in two messages, as the harness may produce them.
  const results: LlmMessage[] = calls
    .flatMap((event) => (event.type === 'tool-call' ? [event.call] : []))
    .toReversed()
    .map((call) => ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          callId: call.id,
          result:
            call.name === 'lookup'
              ? { ok: true, content: [{ type: 'text', text: 'Order A-1: delivered.' }] }
              : { ok: false, error: { code: 'failed', message: 'rules are unavailable' } },
        },
      ],
    }));
  await record('tool-followup', model, {
    messages: [SYSTEM, ask, assistantTurn(calls), ...results],
    tools: TOOLS,
    effort: 'low',
  });
  // A turn with a thinking block before its tool call, then the turn that replays it.
  const puzzle = user(
    'Work out 391 * 17 - 6000 in your head, then call lookup with id "A-<the result>".',
  );
  const thought = await record('thinking', model, {
    messages: [SYSTEM, puzzle],
    tools: TOOLS,
    effort: 'high',
  });
  const answer: LlmMessage[] = thought.flatMap((event) =>
    event.type === 'tool-call'
      ? [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                callId: event.call.id,
                result: { ok: true, content: [{ type: 'text', text: 'Delivered.' }] },
              },
            ],
          },
        ]
      : [],
  );
  await record('thinking-followup', model, {
    messages: [SYSTEM, puzzle, assistantTurn(thought), ...answer],
    tools: TOOLS,
    effort: 'high',
  });
  await record('image', model, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/png', source: { kind: 'base64', data: PIXEL } },
          { type: 'text', text: 'One word: what colour is this pixel?' },
        ],
      },
    ],
    tools: [],
    effort: 'low',
  });
}

await main();
