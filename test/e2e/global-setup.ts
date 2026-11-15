/**
 * Builds the web chat, starts the harness of `harness-launcher.ts` with Bun, and tells the
 * specs where it listens (`YAAH_E2E_URL`). Returns the teardown that stops it.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const READY = /^READY (\S+)$/mu;

function waitUntilReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const url = READY.exec(output)?.[1];
      if (url !== undefined) {
        resolve(url);
      }
    });
    child.once('exit', (code) => {
      reject(new Error(`The harness exited with code ${String(code)} before it was ready.`));
    });
  });
}

export default async function globalSetup(): Promise<() => void> {
  const built = spawnSync('bun', ['run', 'build:web'], { cwd: ROOT, stdio: 'inherit' });
  if (built.status !== 0) {
    throw new Error('bun run build:web failed.');
  }
  const child = spawn('bun', ['run', 'test/e2e/harness-launcher.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.env['YAAH_E2E_URL'] = await waitUntilReady(child);
  return (): void => {
    child.kill('SIGKILL');
  };
}
