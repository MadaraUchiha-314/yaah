import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TemporalLink } from '../../src/app/durable/temporal/connection.ts';
import { connectRemote, startEmbedded } from '../../src/app/durable/temporal/connection.ts';
import { TemporalDurable } from '../../src/app/durable/temporal/durable.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { durableContract } from '../../src/testing/durable-contract.ts';
import { freePort } from '../support/ports.ts';

let link: TemporalLink | undefined = undefined;
let dir = '';
let counter = 0;
const run = String(Date.now());

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yaah-temporal-'));
  link = await startEmbedded({
    namespace: 'default',
    port: await freePort(),
    uiPort: await freePort(),
    dbFilename: join(dir, 'temporal.db'),
  });
}, 180_000);

afterAll(async () => {
  await link?.close();
  await rm(dir, { recursive: true, force: true });
}, 60_000);

durableContract(
  { describe, expect, test },
  'temporal-embedded',
  (deps) => {
    if (link === undefined) {
      throw new Error('the embedded server did not start');
    }
    counter += 1;
    return TemporalDurable.start({
      mode: 'temporal-embedded',
      link,
      ownsLink: false,
      taskQueue: `contract-${run}-${String(counter)}`,
      handlers: deps.handlers,
      limits: deps.limits,
      retry: deps.retry,
      isRetrySafe: deps.isRetrySafe,
      redactor: new Redactor(),
    });
  },
  () => `contract-${run}-${String(counter + 1)}`,
);

describe('connecting to an existing Temporal', () => {
  test('a remote connection reaches the service and reports its dashboard', async () => {
    if (link === undefined) {
      throw new Error('the embedded server did not start');
    }
    // The embedded server stands in for a self-hosted cluster: plain connection, no key.
    const address = link.connection.options.address;
    const remote = await connectRemote({
      address,
      namespace: 'default',
      apiKey: undefined,
      uiUrl: 'https://temporal.example/namespaces/default',
    });
    expect(remote.dashboardUrl).toBe('https://temporal.example/namespaces/default');
    await remote.connection.workflowService.getSystemInfo({});
    await remote.close();
  }, 30_000);
});
