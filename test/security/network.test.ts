import { request as httpRequest } from 'node:http';

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

/**
 * A request with a `Host` of the caller's choosing. `fetch` may not set that header
 * (Node's drops it), so this goes through `node:http`.
 */
function withHost(
  url: string,
  host: string,
  options: { readonly path: string; readonly headers?: Record<string, string>; body?: string },
): Promise<{ status: number; allowOrigin: string | undefined }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname,
        port,
        path: options.path,
        method: options.body === undefined ? 'GET' : 'POST',
        headers: { ...options.headers, host },
      },
      (response) => {
        response.resume();
        const allowed = response.headers['access-control-allow-origin'];
        resolve({ status: response.statusCode ?? 0, allowOrigin: allowed });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

/** The JSON-RPC send of {@link rpc}, with a `Host` and an `Origin` of the caller's choosing. */
function rpcAs(harness: TestHarness, host: string, origin: string, body: unknown) {
  return withHost(harness.url, host, {
    path: '/a2a',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', origin },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: body },
    }),
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
   * Scenario: A page that rebinds its name to loopback cannot drive the harness
   *   Given a harness listening on loopback
   *   When a page at http://evil.example:<port>, its name now pointing at 127.0.0.1,
   *        posts to /a2a with that Host and that Origin
   *   Then it is rejected with 403, no task is created and the model is not called
   *   And a request naming the harness as localhost, or by its bound address, is served
   * Requirement: docs/specs/issue-3/requirements.md abuse case 2 (self-review 1, core #3)
   */
  test('A page that rebinds its name to loopback cannot drive the harness', async () => {
    const harness = await start({ turns: [say('one'), say('two'), say('never')] });
    const { port } = new URL(harness.url);
    const evil = `evil.example:${port}`;
    const rebound = await rpcAs(harness, evil, `http://${evil}`, message([text('hi')]));
    expect(rebound.status).toBe(403);
    expect(rebound.allowOrigin).toBeUndefined();
    // A same-origin page sends no Origin on a GET: the Host alone must be refused.
    const card = await withHost(harness.url, evil, { path: '/.well-known/agent-card.json' });
    expect(card.status).toBe(403);
    expect(await taskCount(harness)).toBe(0);
    expect(harness.llm.requests.length).toBe(0);

    const local = `localhost:${port}`;
    const byName = await rpcAs(harness, local, `http://${local}`, message([text('hi')]));
    expect(byName.status).toBe(200);
    const byAddress = await rpc(harness, message([text('hi')]), { origin: harness.url });
    expect(byAddress.status).toBe(200);
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

describe('part size in bytes', () => {
  /**
   * Feature: Security
   * Scenario: A short text of multibyte characters over the part-size limit is refused
   *   Given a harness that allows parts of 100 bytes
   *   When a message carries a text part of 60 "漢", 191 bytes as JSON but 71 characters
   *   Then it is refused with 413 before any model call
   *   And a text part of 60 ASCII characters is accepted
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8 (critic 1, #4)
   */
  test('A short text of multibyte characters over the part-size limit is refused', async () => {
    const harness = await start({ turns: [say('fine')], config: '[limits]\nmax_part_bytes = 100' });
    const wide = await rpc(harness, message([text('漢'.repeat(60))]));
    expect(wide.status).toBe(413);
    expect(harness.llm.requests.length).toBe(0);
    const narrow = await rpc(harness, message([text('a'.repeat(60))]));
    expect(narrow.status).toBe(200);
  });
});

describe('concurrent new tasks', () => {
  /**
   * Feature: Security
   * Scenario: New-task requests sent together cannot pass the open-task limit
   *   Given a harness that allows one open task per caller
   *   And an admission check that takes a while to answer
   *   When one caller sends four new-task requests at once
   *   Then one creates a task and the other three are refused with 429
   *   And a message to the task that exists is still accepted
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8 (critic 1, #3)
   */
  test('New-task requests sent together cannot pass the open-task limit', async () => {
    const harness = await start({
      turns: [say('one'), say('two'), say('three'), say('four'), say('again')],
      config: '[limits]\nmax_open_tasks_per_caller = 1',
      setup: (ctx) => {
        ctx.a2a.addAdmission(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 200);
            }),
        );
      },
    });
    const keepOpen = { metadata: { [EXT.taskLifecycle]: { longRunning: true } } };
    const responses = await Promise.all(
      ['a', 'b', 'c', 'd'].map((context) =>
        rpc(harness, message([text(context)], { ...keepOpen, contextId: `ctx-${context}` })),
      ),
    );
    const statuses = responses.map((response) => response.status).toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 429, 429, 429]);
    expect(await taskCount(harness)).toBe(1);

    const listed = await harness.client.listTasks({
      tenant: '',
      contextId: '',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
    });
    const taskId = listed.tasks[0]?.id ?? '';
    const follow = await rpc(harness, message([text('more')], { taskId }));
    expect(follow.status).toBe(200);
  });
});

describe('one budget per caller', () => {
  /**
   * Feature: Security
   * Scenario: Both bindings count against one rate limit
   *   Given a harness that allows two requests a minute per caller
   *   When one caller alternates between JSON-RPC at /a2a and REST at /a2a/rest
   *   Then its third request is refused with 429, whichever binding it uses
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8 (self-review 2, #13)
   */
  test('Both bindings count against one rate limit', async () => {
    const harness = await start({ config: '[limits]\nmax_requests_per_minute = 2' });
    const rest = () =>
      fetch(`${harness.url}/a2a/rest/tasks/none`, { headers: { 'a2a-version': '1.0' } });
    const statuses = [
      (await rpc(harness, message([text('x')], { taskId: 'none' }))).status,
      (await rest()).status,
      (await rpc(harness, message([text('x')], { taskId: 'none' }))).status,
      (await rest()).status,
    ];
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect(statuses.slice(0, 2)).not.toContain(429);
  });
});

describe('behind a proxy', () => {
  /**
   * Feature: Security
   * Scenario: A caller behind the proxy cannot pick its own key with X-Forwarded-For
   *   Given a harness that trusts the proxy in front of it, with a small rate limit
   *   When one caller sends many requests, each naming a different client first in
   *        X-Forwarded-For, after the proxy's own entry for it
   *   Then the requests are counted against the address the proxy saw, and refused with 429
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8 (self-review 1, core #7)
   */
  test('A caller behind the proxy cannot pick its own key with X-Forwarded-For', async () => {
    const harness = await start({
      config: '[server]\nport = 0\ntrust_proxy = true\n[limits]\nmax_requests_per_minute = 3',
    });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      // The client wrote the first entry; the proxy appended the address it saw.
      const forwarded = `198.51.100.${String(index)}, 203.0.113.7`;
      // oxlint-disable-next-line no-await-in-loop -- requests are counted in order
      const response = await rpc(harness, message([text('x')], { taskId: 'none' }), {
        'x-forwarded-for': forwarded,
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('behind two proxies', () => {
  /**
   * Feature: Security
   * Scenario: Behind two proxies each caller has a key of its own, and still cannot choose it
   *   Given a harness behind two proxies, told so by a hop count or by the proxies' addresses,
   *        with a small rate limit
   *   When five callers send one request each, the outer proxy naming each, the inner one
   *        naming the outer
   *   Then none is refused
   *   When one caller sends many requests, each naming a different client first
   *   Then they are counted against the address the outer proxy saw, and refused with 429
   * Requirement: docs/specs/issue-3/requirements.md abuse case 8 (self-review 2, #14)
   */
  test('Behind two proxies each caller has a key of its own, and still cannot choose it', async () => {
    for (const trust of ['2', '["127.0.0.1", "::1", "203.0.113.7"]']) {
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      const harness = await start({
        config: `[server]\nport = 0\ntrust_proxy = ${trust}\n[limits]\nmax_requests_per_minute = 3`,
      });
      const send = (forwarded: string) =>
        rpc(harness, message([text('x')], { taskId: 'none' }), { 'x-forwarded-for': forwarded });
      const callers: number[] = [];
      const one: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- requests are counted in order
        callers.push((await send(`198.51.100.${String(index)}, 203.0.113.7`)).status);
      }
      for (let index = 0; index < 5; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- requests are counted in order
        one.push((await send(`192.0.2.${String(index)}, 198.51.100.9, 203.0.113.7`)).status);
      }
      expect(callers).not.toContain(429);
      expect(one.at(-1)).toBe(429);
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await harness.stop();
      running = undefined;
    }
  });
});

describe('fail closed: a wider bind', () => {
  /**
   * Feature: Security
   * Scenario: A non-loopback bind is announced as unauthenticated
   *   Given a configuration that binds every interface
   *   When the harness starts
   *   Then it says at start-up that the API has no authentication and where it listens
   *   And with the default bind it says nothing of the kind
   * Requirement: docs/specs/issue-3/requirements.md Security considerations — fail closed
   */
  test('A non-loopback bind is announced as unauthenticated', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      const wide = await start({ config: '[server]\nhost = "0.0.0.0"\nport = 0' });
      expect(written.join('')).toContain('has no authentication');
      expect(written.join('')).toContain(wide.url);
      // A wildcard bind is reached by any of the machine's addresses, never by a name.
      const { port } = new URL(wide.url);
      const card = (host: string) =>
        withHost(wide.url, host, { path: '/.well-known/agent-card.json' });
      expect((await card(`127.0.0.1:${port}`)).status).toBe(200);
      expect((await card(`evil.example:${port}`)).status).toBe(403);
      await wide.stop();
      written.length = 0;
      await start({});
      expect(written.join('')).not.toContain('has no authentication');
    } finally {
      process.stderr.write = original;
    }
  });
});

describe('the names of the listener', () => {
  /**
   * Feature: Security
   * Scenario: The listener is reached by its loopback names in any case, on a wildcard bind too
   *   Given a harness bound to every interface, and one bound to loopback
   *   When requests name the harness as localhost:<port>, LOCALHOST:<port> or [::1]:<port>
   *   Then each is served
   *   And a name that is neither loopback, the bound host nor an allowed origin is refused
   * Requirement: docs/specs/issue-3/requirements.md abuse case 2 (self-review 2, #7)
   */
  test('The listener is reached by its loopback names in any case, on a wildcard bind too', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => true;
    try {
      for (const config of ['[server]\nhost = "0.0.0.0"\nport = 0', '[server]\nport = 0']) {
        // oxlint-disable-next-line no-await-in-loop -- one harness at a time
        const harness = await start({ config });
        const { port } = new URL(harness.url);
        const card = (host: string) =>
          withHost(harness.url, host, { path: '/.well-known/agent-card.json' });
        for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
          // oxlint-disable-next-line no-await-in-loop -- requests in order
          expect([host, (await card(host)).status]).toEqual([host, 200]);
        }
        // oxlint-disable-next-line no-await-in-loop -- requests in order
        expect((await card(`evil.example:${port}`)).status).toBe(403);
        // oxlint-disable-next-line no-await-in-loop -- one harness at a time
        await harness.stop();
        running = undefined;
      }
    } finally {
      process.stderr.write = original;
    }
  });
});
