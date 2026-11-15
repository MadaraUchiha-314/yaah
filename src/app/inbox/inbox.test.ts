import { expect, test } from 'bun:test';

import { createMemoryPersistence } from '../../harness/core/memory-persistence.ts';
import type { InboxItem } from '../../harness/core/types.ts';
import type { DurableExecution } from '../durable/types.ts';
import { Inbox } from './inbox.ts';

test('an item sent again is handed over while pending, and not once it is consumed', async () => {
  const delivered: string[] = [];
  const durable: DurableExecution = {
    mode: 'none',
    deliver: (_taskId, ref) => {
      delivered.push(ref.id);
      return Promise.resolve();
    },
    cancel: () => Promise.resolve(),
    recover: () => Promise.resolve(),
    dashboard: () => null,
    taskUrl: () => null,
    close: () => Promise.resolve(),
  };
  const store = createMemoryPersistence().inbox;
  const inbox = new Inbox(store, durable);
  const item: InboxItem = {
    id: 't1:m1',
    taskId: 't1',
    receivedAt: new Date().toISOString(),
    interrupt: false,
    payload: { kind: 'message', parts: [{ type: 'text', text: 'hi' }] },
  };
  expect(await inbox.accept(item)).toBe('stored');
  expect(await inbox.accept(item)).toBe('duplicate');
  await store.markProcessed([item.id]);
  expect(await inbox.accept(item)).toBe('consumed');
  expect(delivered).toEqual([item.id, item.id]);
});
