/**
 * Records the HTTP responses the OpenAI provider tests replay.
 *
 * Run by hand, never by the test suite — it calls the real API and costs a few cents:
 *
 * ```sh
 * OPENAI_API_KEY=… bun run scripts/record-llm-fixtures.ts [model]
 * ```
 *
 * It writes the raw server-sent-event body of each scenario under
 * `test/fixtures/llm/openai/` (Responses API) and `test/fixtures/llm/openai-compatible/`
 * (Chat Completions API, recorded against api.openai.com as an OpenAI-compatible
 * endpoint). Only response **bodies** are saved: no request, no header, so neither the key
 * nor an organisation id reaches a file. The script still refuses to write a body in which
 * the key appears. The error fixtures (`error-*.json`) are hand-written and not touched.
 *
 * A `.sse` fixture that starts with a `: Hand-written …` comment line was written from the
 * documented event shapes, not recorded; running this script replaces it with a recording.
 * After recording, run the tests: assertions on token counts and call ids in
 * `test/contract/llm-openai*.test.ts` name the fixture's values and need updating.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const BASE_URL = 'https://api.openai.com/v1';
const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures', 'llm');

const LOOKUP_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
};
const RULES_SCHEMA = { type: 'object', properties: {} };

const SAY_HELLO = 'Reply with exactly this text and nothing else: Hello, world.';
const CALL_BOTH =
  'Call the lookup tool for order A-1 and the rules tool, both in this same turn, in ' +
  'parallel, lookup first. Do not write any text.';

interface Scenario {
  readonly file: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function responsesBody(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'low' },
    max_output_tokens: 2000,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] },
      { role: 'user', content: [{ type: 'input_text', text: prompt }] },
    ],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look an order up.',
        parameters: LOOKUP_SCHEMA,
        strict: false,
      },
      {
        type: 'function',
        name: 'rules',
        description: 'Refund rules.',
        parameters: RULES_SCHEMA,
        strict: false,
      },
    ],
  };
}

function chatBody(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 2000,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: prompt },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', description: 'Look an order up.', parameters: LOOKUP_SCHEMA },
      },
      {
        type: 'function',
        function: { name: 'rules', description: 'Refund rules.', parameters: RULES_SCHEMA },
      },
    ],
  };
}

function scenarios(model: string): readonly Scenario[] {
  return [
    { file: 'openai/text.sse', path: '/responses', body: responsesBody(model, SAY_HELLO) },
    {
      file: 'openai/parallel-tools.sse',
      path: '/responses',
      body: responsesBody(model, CALL_BOTH),
    },
    {
      file: 'openai-compatible/text.sse',
      path: '/chat/completions',
      body: chatBody(model, SAY_HELLO),
    },
    {
      file: 'openai-compatible/parallel-tools.sse',
      path: '/chat/completions',
      body: chatBody(model, CALL_BOTH),
    },
  ];
}

async function record(scenario: Scenario, key: string): Promise<void> {
  const response = await fetch(`${BASE_URL}${scenario.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(scenario.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${scenario.file}: HTTP ${response.status}: ${text.replaceAll(key, '***')}`);
  }
  if (text.includes(key)) {
    throw new Error(`${scenario.file}: the response body contains the API key; not written`);
  }
  const target = join(FIXTURES, scenario.file);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, text);
  console.log(`recorded ${scenario.file} (${text.length} bytes)`);
}

const key = process.env['OPENAI_API_KEY'];
if (key === undefined || key === '') {
  throw new Error('OPENAI_API_KEY is not set');
}
const model = process.argv[2] ?? DEFAULT_MODEL;
for (const scenario of scenarios(model)) {
  // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the spend visible
  await record(scenario, key);
}
