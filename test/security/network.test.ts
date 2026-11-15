import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { defaultConfig } from '../../src/kernel/config.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

async function start(options: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  running = await startHarness(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function rpc(harness: TestHarness, message: unknown, headers: Record<string, string> = {}) {
  return fetch(`${harness.url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } }),
  });
}

const text = (value: string) => ({ text: value });
const message = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  messageId: `m-${String(Math.random())}`,
  role: 'ROLE_USER',
  parts,
  ...extra,
});

async function taskCount(harness: TestHarness): Promise<number> {
  const listed = await harness.client.listTasks({
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
  });
  return listed.totalSize;
}

describe('network boundary', () => {
  /**
   * Feature: Security
   * Scenario: The harness listens on loopback unless told otherwise
   *   Given a configuration that names no bind address
   *   When the harness starts
   *   Then it listens on the loopback interface only
   * Requirement: docs/specs/issue-3/requirements.md abuse case 1
   */
  test('The harness listens on loopback unless told otherwise', async () => {
    expect(defaultConfig().server.host).toBe('127.0.0.1');
    const harness = await start({});
    expect(new URL(harness.url).hostname).toBe('127.0.0.1');
  });

  /**
   * Feature: Security
   * Scenario: A browser request from a foreign origin is rejected
   *   Given a running harness
   *   When a request arrives with an Origin that is neither the harness's own nor allowed
   *   Then it is rejected with 403, no task is created and the model is not called
   * Requirement: docs/specs/issue-3/requirements.md abuse case 2
   */
  test('A browser request from a foreign origin is rejected', async () => {
    const harness = await start({ turns: [say('never')] });
    const response = await rpc(harness, message([text('hi')]), { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await taskCount(harness)).toBe(0);
    expect(harness.llm.requests.length).toBe(0);
    const preflight = await fetch(`${harness.url}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
  });

  /**
   * Feature: Security
   * Scenario: The harness's own origin and an allowed origin may call
   *   Given a harness configured with one allowed origin
   *   When requests arrive from its own origin and from the allowed origin
   *   Then both are served, and a preflight from the allowed origin is answered
   * Requirement: docs/specs/issue-3/requirements.md abuse case 2
   */
  test("The harness's own origin and an allowed origin may call", async () => {
    const harness = await start({
      turns: [say('one'), say('two')],
      config: '[server]\nport = 0\nallowed_origins = ["https://app.example"]',
    });
    const own = await rpc(harness, message([text('hi')]), { origin: harness.url });
    expect(own.status).toBe(200);
    const allowed = await rpc(harness, message([text('hi')]), { origin: 'https://app.example' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const preflight = await fetch(`${harness.url}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
  });

  /**
   * Feature: Security
   * Scenario: An oversized or flooding request is rejected before any model call
   *   Given a harness with small limits
   *   When a message has too many parts, a part is too large, the body is too large,
   *        the caller has too many open tasks, or sends too many requests
   *   Then each is rejected, and a fresh context id per request does not get around it
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8
   */
  test('An oversized or flooding request is rejected before any model call', async () => {
    const harness = await start({
      turns: [say('one'), say('two'), say('never')],
      config: [
        '[limits]',
        'max_parts = 2',
        'max_part_bytes = 200',
        'max_body_bytes = 2000',
        'max_open_tasks_per_caller = 2',
        'max_requests_per_minute = 9',
      ].join('\n'),
    });
    const tooMany = await rpc(harness, message([text('a'), text('b'), text('c')]));
    expect(tooMany.status).toBe(413);
    const tooBig = await rpc(harness, message([text('x'.repeat(300))]));
    expect(tooBig.status).toBe(413);
    const hugeBody = await rpc(
      harness,
      message([text('x'.repeat(150)), text('y'.repeat(150))], { pad: 'z'.repeat(3000) }),
    );
    expect(hugeBody.status).toBe(413);
    expect(harness.llm.requests.length).toBe(0);

    const keepOpen = { metadata: { [EXT.taskLifecycle]: { longRunning: true } } };
    expect(
      (await rpc(harness, message([text('1')], { ...keepOpen, contextId: 'ctx-a' }))).status,
    ).toBe(200);
    expect(
      (await rpc(harness, message([text('2')], { ...keepOpen, contextId: 'ctx-b' }))).status,
    ).toBe(200);
    const third = await rpc(harness, message([text('3')], { ...keepOpen, contextId: 'ctx-c' }));
    expect(third.status).toBe(429);
    expect(harness.llm.requests.length).toBe(2);

    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- requests are counted in order
      statuses.push((await rpc(harness, message([text('more')], { taskId: 'none' }))).status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(harness.llm.requests.length).toBe(2);
  });
});
