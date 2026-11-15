/**
 * The demo harness (`bun run demo:up`): one real harness with a real model, the web chat
 * at `/`, an orders MCP server and a refund-desk prompt. Prints `READY <url>` when up
 * and runs until interrupted.
 *
 * Environment:
 *   YAAH_DEMO_MODEL    the LLM entity id (default `openai/gpt-6.1-sol`)
 *   YAAH_DEMO_DURABLE  `temporal-remote` (default), `temporal-embedded` or `none`
 *   YAAH_DEMO_PORT     the port (default 7420)
 *   YAAH_DEMO_LOG      the log file (default: standard error)
 * Keys come from the environment, or from the desktop keyring when they are not set.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { definePrompt } from '../../src/harness/system-prompt/prompt.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { ensureKey } from '../../test/live/keys.ts';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

const model = env('YAAH_DEMO_MODEL', 'openai/gpt-6.1-sol');
const durable = env('YAAH_DEMO_DURABLE', 'temporal-remote');
const logFile = process.env['YAAH_DEMO_LOG'];

ensureKey('OPENAI_API_KEY', 'openai');
ensureKey('ANTHROPIC_API_KEY', 'anthropic');
ensureKey('TEMPORAL_API_KEY', 'temporal');

const config = parseConfig(
  [
    'composition = "server"',
    `data_dir = ${JSON.stringify(env('YAAH_DEMO_DATA', ':memory:'))}`,
    `model = { llm = ${JSON.stringify(model)}, effort = "low" }`,
    '[server]',
    `port = ${env('YAAH_DEMO_PORT', '7420')}`,
    '[o11y]',
    'log_level = "info"',
    ...(logFile === undefined ? [] : [`log_file = ${JSON.stringify(logFile)}`]),
    '[durable]',
    `mode = ${JSON.stringify(durable)}`,
    '[durable.temporal]',
    ...(durable === 'temporal-remote'
      ? [
          `address = ${JSON.stringify(env('YAAH_DEMO_TEMPORAL_ADDRESS', 'yaah.gtebu.tmprl.cloud:7233'))}`,
          `namespace = ${JSON.stringify(env('YAAH_DEMO_TEMPORAL_NAMESPACE', 'yaah.gtebu'))}`,
          `task_queue = "yaah-demo-${String(Date.now())}"`,
        ]
      : ['port = 17233', 'ui_port = 18233']),
    '[[mcp.servers]]',
    'id = "orders"',
    'transport = "stdio"',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(here('./orders-mcp.ts'))}]`,
  ].join('\n'),
  'demo.toml',
);

const harness = await createHarness({
  config,
  setup: (ctx) => {
    registerEntity(
      ctx,
      definePrompt({
        id: 'demo/refund-desk',
        extends: 'system',
        template: readFileSync(here('./refund-desk.md'), 'utf8'),
      }),
    );
  },
});

console.log(`READY ${harness.ctx.http.url}`);

const stop = (): void => {
  harness
    .dispose()
    .catch(() => undefined)
    .finally(() => {
      process.exit(0);
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
