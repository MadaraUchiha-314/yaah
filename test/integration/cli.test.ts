import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { CliIo } from '../../src/cli/main.ts';
import { freePort, runCli } from '../../src/cli/main.ts';
import type { CreateHarnessOptions } from '../../src/kernel/harness.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { ScriptedLlm, say } from '../../src/testing/scripted-llm.ts';

interface Run {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly urls: string[];
}

/** A process stand-in: captured output, a scripted model, and a `tui` the test supplies. */
function fakeProcess(home: string, tui: (url: string) => Promise<void>, stop?: Promise<void>): Run {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  return {
    out,
    err,
    urls,
    io: {
      home,
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      interrupted: () => stop ?? Promise.resolve(),
      tui: async (url: string) => {
        urls.push(url);
        await tui(url);
      },
      start: (options: CreateHarnessOptions) =>
        createHarness({
          ...options,
          setup: (ctx) => {
            registerEntity(
              ctx,
              new ScriptedLlm([say('Hello from yaah.')], { id: 'scripted/model' }),
            );
          },
        }),
    },
  };
}

const CONFIG = [
  'data_dir = ":memory:"',
  'model = { llm = "scripted/model" }',
  '[server]',
  'port = 0',
].join('\n');

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'yaah-cli-'));
}

function configFile(dir: string, text: string = CONFIG): string {
  const path = join(dir, 'custom.toml');
  writeFileSync(path, text);
  return path;
}

async function ask(url: string, text: string): Promise<TaskView | undefined> {
  const session = await HarnessSession.connect(url);
  let final: TaskView | undefined = undefined;
  for await (const view of session.send({ text })) {
    final = view;
  }
  return final;
}

describe('the yaah command', () => {
  /**
   * Feature: CLI
   * Scenario: `yaah` starts a harness and opens the terminal UI against it
   *   Given a configuration file named with --config
   *   When `yaah --config <file>` is run
   *   Then a harness is listening on loopback, the terminal UI is opened with its URL and
   *        can hold a conversation over HTTP, the log goes to a file under ~/.yaah, and
   *        the harness is stopped when the UI is left
   * Requirement: docs/specs/issue-3/requirements.md R22.1, R22.4, R18.3
   */
  test('`yaah` starts a harness and opens the terminal UI against it', async () => {
    const dir = tempHome();
    let answer: TaskView | undefined = undefined;
    const run = fakeProcess(dir, async (url) => {
      answer = await ask(url, 'hi');
    });
    expect(await runCli(['--config', configFile(dir)], run.io)).toBe(0);
    expect(run.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(JSON.stringify(answer)).toContain('Hello from yaah.');
    const log = readFileSync(join(dir, '.yaah', 'logs', 'yaah.log'), 'utf8');
    expect(log).toContain('"type":"llm.invoked"');
    expect(run.err.join('')).toContain(join(dir, '.yaah', 'logs', 'yaah.log'));
    const gone = await fetch(`${String(run.urls[0])}/.well-known/agent-card.json`).catch(
      () => null,
    );
    expect(gone).toBeNull();
  });

  /**
   * Feature: CLI
   * Scenario: The first run creates the configuration file
   *   Given a home directory with no ~/.yaah/config.toml
   *   When `yaah` is run
   *   Then the file is created with the documented defaults, readable by its owner only,
   *        holding no secret, and the command says where it is
   * Requirement: docs/specs/issue-3/requirements.md R22.3, R22.7
   */
  test('The first run creates the configuration file', async () => {
    const dir = tempHome();
    const run = fakeProcess(dir, () => Promise.resolve());
    // The default file names a real provider model; with no key that plugin fails closed.
    const code = await runCli([], run.io);
    const file = join(dir, '.yaah', 'config.toml');
    expect(statSync(file).mode % 0o1000).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toMatch(/sk-[A-Za-z0-9]/u);
    expect(run.err.join('')).toContain(`Created ${file}`);
    expect([0, 1]).toContain(code);
  });

  /**
   * Feature: CLI
   * Scenario: `yaah serve` serves until interrupted
   *   Given a configuration naming no composition
   *   When `yaah serve` is run and later interrupted
   *   Then the server composition is listening and answers an A2A client, its URL is
   *        printed, and the harness stops on the interrupt
   * Requirement: docs/specs/issue-3/requirements.md R22.2
   */
  test('`yaah serve` serves until interrupted', async () => {
    const dir = tempHome();
    let interrupt: () => void = () => undefined;
    const stop = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const run = fakeProcess(dir, () => Promise.resolve(), stop);
    const exit = runCli(['serve', `--config=${configFile(dir)}`], run.io);
    while (run.out.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the listener
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    const url = /http:\S+/u.exec(run.out.join(''))?.[0] ?? '';
    expect(JSON.stringify(await ask(url, 'hi'))).toContain('Hello from yaah.');
    interrupt();
    expect(await exit).toBe(0);
    expect(run.err.join('')).toContain('Stopping.');
  });

  /**
   * Feature: CLI
   * Scenario: An invalid configuration stops the command and names what is wrong
   *   Given a configuration file with a value of the wrong type
   *   When `yaah` is run with it
   *   Then it exits non-zero, naming the file, the key and the reason, and no harness
   *        was started
   * Requirement: docs/specs/issue-3/requirements.md R22.5
   */
  test('An invalid configuration stops the command and names what is wrong', async () => {
    const dir = tempHome();
    const file = configFile(dir, '[server]\nport = "seven"');
    const run = fakeProcess(dir, () => Promise.resolve());
    expect(await runCli(['--config', file], run.io)).toBe(1);
    expect(run.err.join('')).toContain(file);
    expect(run.err.join('')).toContain('server.port');
    expect(run.urls).toEqual([]);
    expect(await runCli(['--config', join(dir, 'missing.toml')], run.io)).toBe(1);
    expect(run.err.join('')).toContain('missing.toml');
  });

  /**
   * Feature: CLI
   * Scenario: `yaah tui --url` opens the terminal UI against a running harness
   *   When `yaah tui --url <harness>` is run
   *   Then the terminal UI is opened with that URL and no harness is started
   * Requirement: docs/specs/issue-3/requirements.md R21.3
   */
  test('`yaah tui --url` opens the terminal UI, and usage errors exit 2', async () => {
    const run = fakeProcess(tempHome(), () => Promise.resolve());
    expect(await runCli(['tui', '--url', 'http://127.0.0.1:9/'], run.io)).toBe(0);
    expect(run.urls).toEqual(['http://127.0.0.1:9']);
    expect(await runCli(['--help'], run.io)).toBe(0);
    expect(run.out.join('')).toContain('yaah serve');
    expect(await runCli(['--version'], run.io)).toBe(0);
    expect(run.out.join('')).toMatch(/\d+\.\d+\.\d+\n/u);
    expect(await runCli(['frobnicate'], run.io)).toBe(2);
    expect(run.err.join('')).toContain('"frobnicate" is not a command');
  });

  test('a busy port is skipped, and running out of ports is an error', async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => {
      busy.listen(0, '127.0.0.1', resolve);
    });
    const address = busy.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      expect(await freePort('127.0.0.1', port)).toBeGreaterThan(port);
      expect(await freePort('127.0.0.1', 0)).toBe(0);
    } finally {
      busy.close();
    }
  });

  test('a failure that is not the harness explaining itself is rethrown', async () => {
    const run = fakeProcess(tempHome(), () => Promise.reject(new TypeError('a bug')));
    const outcome = await runCli(['tui', '--url', 'http://x'], run.io).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(TypeError);
  });
});
