/**
 * A harness in its own process, for the crash tests: the test kills it with SIGKILL and
 * starts it again on the same data directory.
 *
 * Environment: DATA_DIR, PORT, LOG_FILE (one line per model call and per tool run),
 * HANG_FILE (while it exists, tools never return), and optionally TEMPORAL_ADDRESS with
 * TEMPORAL_NAMESPACE and TEMPORAL_KEY_ENV (the variable holding the API key).
 */
import { appendFileSync, existsSync } from 'node:fs';

import type { LlmEvent, LlmRequest } from '../../src/harness/models/llm/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';

const env = (name: string): string => process.env[name] ?? '';
const log = (line: string): void => {
  appendFileSync(env('LOG_FILE'), `${line}\n`);
};

/** Never resolves while the hang file exists: the tool is "mid-flight" when the process dies. */
async function maybeHang(): Promise<void> {
  while (existsSync(env('HANG_FILE'))) {
    // oxlint-disable-next-line no-await-in-loop -- polling a file
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

const tool = (id: string, retrySafe: boolean) =>
  defineTool({
    id,
    description: id,
    inputSchema: { type: 'object' },
    retrySafe,
    invoke: async () => {
      log(id);
      await maybeHang();
      return textResult(`${id} finished`);
    },
  });

/** A model with no memory of its own: what it says depends only on what it is shown. */
function respond(request: LlmRequest): readonly LlmEvent[] {
  log('llm');
  const shown = JSON.stringify(request.messages);
  const result = request.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === 'tool-result');
  if (result?.type === 'tool-result') {
    return say(result.result.ok ? 'The tool finished.' : `Outcome: ${result.result.error.code}`);
  }
  return callTools(call('c1', shown.includes('refund') ? 'refund' : 'lookup'));
}

const temporal = env('TEMPORAL_ADDRESS');
const config = parseConfig(
  [
    'composition = "server"',
    `data_dir = ${JSON.stringify(env('DATA_DIR'))}`,
    'model = { llm = "scripted/model", effort = "medium" }',
    `[server]\nport = ${env('PORT')}`,
    temporal === ''
      ? '[durable.retry]\ninitial_interval_ms = 5\nmaximum_attempts = 3'
      : `[durable]\nmode = "temporal-remote"\n[durable.temporal]\naddress = ${JSON.stringify(temporal)}\nnamespace = ${JSON.stringify(env('TEMPORAL_NAMESPACE') || 'default')}\napi_key_env = ${JSON.stringify(env('TEMPORAL_KEY_ENV') || 'YAAH_NO_KEY')}\ntask_queue = ${JSON.stringify(env('TASK_QUEUE'))}`,
  ].join('\n'),
  'chaos.toml',
);

const harness = await createHarness({
  config,
  setup: (ctx) => {
    registerEntity(ctx, new ScriptedLlm(Array.from({ length: 50 }, () => respond)));
    registerEntity(ctx, tool('refund', false));
    registerEntity(ctx, tool('lookup', true));
  },
});
process.stdout.write(`READY ${harness.ctx.http.url}\n`);
