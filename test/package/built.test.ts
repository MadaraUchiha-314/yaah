import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'bun:test';

import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';

const BIN = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const REPLY = readFileSync(
  fileURLToPath(new URL('../fixtures/llm/openai-compatible/text.sse', import.meta.url)),
);

let child: ChildProcess | undefined = undefined;
let stopProvider: (() => void) | undefined = undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  stopProvider?.();
  child = undefined;
  stopProvider = undefined;
});

/** A stand-in for an OpenAI-compatible provider: answers every call with a recorded stream. */
async function provider(): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    calls.push(request.url ?? '');
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(REPLY);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  stopProvider = (): void => {
    server.closeAllConnections();
    server.close();
  };
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}/v1`, calls };
}

function listeningUrl(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    process.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/\S+/u.exec(output)?.[0];
      if (url !== undefined) {
        resolve(url);
      }
    });
    process.once('exit', (code) => {
      reject(new Error(`yaah exited with ${String(code)} before listening`));
    });
  });
}

describe('the built package', () => {
  /**
   * Feature: CLI, SDK and configuration
   * Scenario: The built package runs on Node and answers over A2A
   *   Given the package built into dist/
   *   When `node dist/cli/bin.js serve --config <file>` is started with a configuration
   *        naming an OpenAI-compatible endpoint
   *   Then it prints where it listens, an A2A client gets the model's answer through it,
   *        and it stops cleanly on SIGTERM
   * Requirement: docs/specs/issue-3/requirements.md R22.1, R22.2, R22.6, R6.4
   */
  test('The built package runs on Node and answers over A2A', async () => {
    const llm = await provider();
    const dir = mkdtempSync(join(tmpdir(), 'yaah-built-'));
    const config = join(dir, 'config.toml');
    writeFileSync(
      config,
      [
        'data_dir = ":memory:"',
        'model = { llm = "local/test-model" }',
        '[server]',
        'port = 0',
        '[o11y]',
        `log_file = ${JSON.stringify(join(dir, 'yaah.log'))}`,
        '[[providers.compatible]]',
        'id = "local"',
        `base_url = ${JSON.stringify(llm.url)}`,
        'models = ["test-model"]',
      ].join('\n'),
    );
    child = spawn('node', [BIN, 'serve', '--config', config], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise<number | null>((resolve) => {
      child?.once('exit', resolve);
    });
    const session = await HarnessSession.connect(await listeningUrl(child));
    let final: TaskView | undefined = undefined;
    for await (const view of session.send({ text: 'hello' })) {
      final = view;
    }
    expect(llm.calls).toEqual(['/v1/chat/completions']);
    expect(final?.items.some((item) => item.kind === 'agent' && item.text !== '')).toBe(true);
    expect(readFileSync(join(dir, 'yaah.log'), 'utf8')).toContain('"type":"llm.invoked"');
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 30_000);

  test('the executable reports its version and rejects a bad command line', () => {
    const version = spawnSync('node', [BIN, '--version'], { encoding: 'utf8' });
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/u);
    const bad = spawnSync('node', [BIN, 'frobnicate'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('is not a command');
  });
});
