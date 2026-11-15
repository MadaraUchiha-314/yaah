import { expect, test } from 'bun:test';

import { ConnectedCaller, connectedCaller } from './caller.ts';

test('the caller of a request is unauthenticated, and told when its response closes', async () => {
  const listeners: (() => void)[] = [];
  const res = {
    once: (_event: 'close', listener: () => void): void => {
      listeners.push(listener);
    },
  };
  const caller = await connectedCaller({ res });
  expect(caller.isAuthenticated).toBe(false);
  expect(caller.userName).toBe('');
  expect(caller instanceof ConnectedCaller && caller.closed.aborted).toBe(false);
  for (const listener of listeners) {
    listener();
  }
  expect(caller instanceof ConnectedCaller && caller.closed.aborted).toBe(true);
});

test('a request without a response gives a caller that never closes', async () => {
  const caller = await connectedCaller({});
  expect(caller instanceof ConnectedCaller && caller.closed.aborted).toBe(false);
});
