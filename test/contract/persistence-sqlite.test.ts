import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transaction } from '../../src/harness/core/sqlite-driver.ts';
import { openSqlitePersistence } from '../../src/harness/core/sqlite-persistence.ts';
import { persistenceContract } from '../../src/testing/persistence-contract.ts';

const dir = await mkdtemp(join(tmpdir(), 'yaah-sqlite-'));
let counter = 0;
const opened: { close(): void }[] = [];

afterAll(async () => {
  for (const backend of opened) {
    backend.close();
  }
  await rm(dir, { recursive: true, force: true });
});

persistenceContract({ describe, expect, test }, () => {
  counter += 1;
  const backend = openSqlitePersistence(join(dir, `db-${String(counter)}.sqlite`));
  opened.push(backend);
  return backend;
});

describe('sqlite persistence', () => {
  test('what one connection wrote is there for the next', async () => {
    const file = join(dir, 'reopen.sqlite');
    const first = openSqlitePersistence(file);
    await first.conversation.put('t1', 't1/0/a/', [
      { type: 'message', role: 'user', parts: [{ type: 'text', text: 'kept' }], sourceId: 'm1' },
    ]);
    await first.state.set('t1', 't1/1/s/x', 'x', { n: 1 });
    await first.inbox.put({
      id: 'm2',
      taskId: 't1',
      receivedAt: '2026-01-01T00:00:00.000Z',
      interrupt: true,
      payload: { kind: 'action', action: 'complete' },
    });
    await first.journal.record('t1/0/a/', { done: true });
    first.close();

    const second = openSqlitePersistence(file);
    opened.push(second);
    expect((await second.conversation.read('t1')).length).toBe(1);
    expect(await second.state.get('t1', 'x')).toEqual({ n: 1 });
    expect((await second.inbox.pending('t1'))[0]?.interrupt).toBe(true);
    expect((await second.journal.get('t1/0/a/'))?.result).toEqual({ done: true });
    // A replayed step still replaces rather than appends after a restart.
    await second.conversation.put('t1', 't1/0/a/', [
      { type: 'message', role: 'user', parts: [{ type: 'text', text: 'again' }], sourceId: 'm1' },
    ]);
    expect((await second.conversation.read('t1')).length).toBe(1);
  });

  test('a failed transaction leaves nothing behind', async () => {
    const backend = openSqlitePersistence(join(dir, 'rollback.sqlite'));
    opened.push(backend);
    let message = '';
    try {
      transaction(backend.database, () => {
        backend.database.prepare("INSERT INTO plans (task_id, plan) VALUES ('t1', '{}')").run();
        throw new Error('halfway');
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('halfway');
    expect(await backend.plan.load('t1')).toBeUndefined();
  });
});
