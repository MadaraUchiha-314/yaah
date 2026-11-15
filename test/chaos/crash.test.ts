import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TemporalLink } from '../../src/app/durable/temporal/connection.ts';
import { startEmbedded } from '../../src/app/durable/temporal/connection.ts';
import { ensureKey } from '../live/keys.ts';
import { freePort } from '../support/ports.ts';

const ENTRY = fileURLToPath(new URL('./harness-process.ts', import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
let temporal: TemporalLink | undefined = undefined;
let temporalPort = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yaah-chaos-temporal-'));
  dirs.push(dir);
  temporalPort = await freePort();
  temporal = await startEmbedded({
    namespace: 'default',
    port: temporalPort,
    uiPort: await freePort(),
    dbFilename: join(dir, 'temporal.db'),
  });
}, 240_000);

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

afterAll(async () => {
  await temporal?.close();
  for (const dir of dirs) {
    // oxlint-disable-next-line no-await-in-loop -- a few directories
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

interface Setup {
  readonly env: Record<string, string>;
  readonly logFile: string;
  readonly hangFile: string;
}

type Mode = 'none' | 'temporal' | 'temporal-cloud';

/** The project's Temporal Cloud namespace; the cloud mode runs only when its key is found. */
const CLOUD = {
  address: process.env['YAAH_LIVE_TEMPORAL_ADDRESS'] ?? 'yaah.gtebu.tmprl.cloud:7233',
  namespace: process.env['YAAH_LIVE_TEMPORAL_NAMESPACE'] ?? 'yaah.gtebu',
};
const MODES: readonly Mode[] = ensureKey('TEMPORAL_API_KEY', 'temporal')
  ? ['none', 'temporal', 'temporal-cloud']
  : ['none', 'temporal'];

function temporalEnv(mode: Mode): Record<string, string> {
  if (mode === 'temporal-cloud') {
    return {
      TEMPORAL_ADDRESS: CLOUD.address,
      TEMPORAL_NAMESPACE: CLOUD.namespace,
      TEMPORAL_KEY_ENV: 'TEMPORAL_API_KEY',
    };
  }
  return { TEMPORAL_ADDRESS: mode === 'temporal' ? `127.0.0.1:${String(temporalPort)}` : '' };
}

async function setup(mode: Mode): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'yaah-chaos-'));
  dirs.push(dir);
  const logFile = join(dir, 'calls.log');
  const hangFile = join(dir, 'hang');
  await writeFile(logFile, '');
  await writeFile(hangFile, '');
  return {
    logFile,
    hangFile,
    env: {
      DATA_DIR: dir,
      PORT: String(await freePort()),
      LOG_FILE: logFile,
      HANG_FILE: hangFile,
      TASK_QUEUE: `chaos-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      ...temporalEnv(mode),
    },
  };
}

/** Starts the harness process and resolves with its URL once it is listening. */
function start(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /READY (\S+)/u.exec(output);
      if (match?.[1] !== undefined) {
        resolve({ child, url: match[1] });
      }
    });
    child.once('exit', (code) => {
      reject(new Error(`harness process exited with ${String(code)} before it was ready`));
    });
  });
}

async function lines(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
  every = 100,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, every);
    });
    // oxlint-disable-next-line no-await-in-loop -- polling
    value = await read();
  }
  return value;
}

/**
 * Starts a task whose tool hangs, kills the process with SIGKILL while the tool is
 * mid-flight, restarts it on the same data, and returns what happened.
 */
async function crashMidTool(mode: Mode, text: string) {
  const prepared = await setup(mode);
  const first = await start(prepared.env);
  const client = await new ClientFactory().createFromUrl(first.url);
  const sent = await client.sendMessage({
    tenant: '',
    message: {
      messageId: `chaos-${String(Date.now())}`,
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'text', value: text },
          metadata: undefined,
          filename: '',
          mediaType: '',
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: [],
      taskPushNotificationConfig: undefined,
      returnImmediately: true,
    },
    metadata: undefined,
  });
  const taskId = 'id' in sent ? sent.id : '';
  const tool = text.includes('refund') ? 'refund' : 'lookup';
  await until(
    () => lines(prepared.logFile),
    (seen) => seen.includes(tool),
    20_000,
  );

  first.child.kill('SIGKILL');
  await new Promise((resolve) => {
    first.child.once('exit', resolve);
  });
  await rm(prepared.hangFile);

  const second = await start(prepared.env);
  const again = await new ClientFactory().createFromUrl(second.url);
  const task = await until(
    () => again.getTask({ tenant: '', id: taskId }),
    (current) => current.status?.state === TaskState.TASK_STATE_COMPLETED,
    90_000,
    // Slow enough to stay under the harness's own per-caller rate limit.
    1000,
  );
  const status = (task.status?.message?.parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
  return { state: task.status?.state, status, calls: await lines(prepared.logFile) };
}

const count = (calls: readonly string[], what: string): number =>
  calls.filter((line) => line === what).length;

describe('crash recovery', () => {
  for (const mode of MODES) {
    /**
     * Feature: Durable execution
     * Scenario: A crashed run resumes without repeating a recorded step
     *   Given a task whose tool — not safe to retry — is running when the process is killed
     *   When the harness is started again on the same data
     *   Then the task finishes
     *   And the model call recorded before the crash is not made again
     *   And the tool is not run a second time: the model is told its outcome is unknown
     * Requirement: docs/specs/issue-3/requirements.md R15.6, R17.3, R17.5
     */
    test(`A crashed run resumes without repeating a recorded step (${mode})`, async () => {
      const outcome = await crashMidTool(mode, 'refund order A-1041');
      expect(outcome.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(count(outcome.calls, 'refund')).toBe(1);
      expect(count(outcome.calls, 'llm')).toBe(2);
      expect(outcome.status).toBe('Outcome: unknown-outcome');
    }, 150_000);

    /**
     * Feature: Durable execution
     * Scenario: A tool that is safe to retry is run again after a crash
     *   Given a task whose tool — safe to retry — is running when the process is killed
     *   When the harness is started again on the same data
     *   Then the tool is run again and the task finishes with its result
     *   And the model call recorded before the crash is not made again
     * Requirement: docs/specs/issue-3/requirements.md R17.3, R17.4
     */
    test(`A tool that is safe to retry is run again after a crash (${mode})`, async () => {
      const outcome = await crashMidTool(mode, 'look the order up');
      expect(outcome.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(count(outcome.calls, 'lookup')).toBe(2);
      expect(count(outcome.calls, 'llm')).toBe(2);
      expect(outcome.status).toBe('The tool finished.');
    }, 150_000);
  }
});
