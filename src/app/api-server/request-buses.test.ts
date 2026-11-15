import { expect, test } from 'bun:test';

import { RequestBusManager } from './request-buses.ts';

test('a request overlapping another on the same task gets a bus of its own', () => {
  const manager = new RequestBusManager();
  const primary = manager.createOrGetByTaskId('t1');
  const overlapping = manager.createOrGetByTaskId('t1');
  expect(overlapping).not.toBe(primary);
  expect(manager.getByTaskId('t1')).toBe(primary);
  let finished = 0;
  overlapping.on('finished', () => {
    finished += 1;
  });
  // The overlapping request's bus is finished by the manager; the primary one is not.
  expect(manager.settleByTaskId('t1', overlapping)).toBe(true);
  expect(finished).toBe(1);
  expect(manager.settleByTaskId('t1', primary)).toBe(false);
  // Once released, the next request reuses the primary bus.
  expect(manager.createOrGetByTaskId('t1')).toBe(primary);
});

test('cleaning a task up forgets its primary bus', () => {
  const manager = new RequestBusManager();
  const primary = manager.createOrGetByTaskId('t1');
  manager.cleanupByTaskId('t1');
  manager.cleanupByTaskId('unknown');
  expect(manager.getByTaskId('t1')).toBeUndefined();
  expect(manager.createOrGetByTaskId('t1')).not.toBe(primary);
});

test('a bus lent while idle is released only while no request runs on it', () => {
  const manager = new RequestBusManager();
  const lent = manager.createOrGetByTaskId('t1');
  manager.settleByTaskId('t1', lent);
  // A request began on the bus meanwhile: it keeps it.
  expect(manager.createOrGetByTaskId('t1')).toBe(lent);
  manager.releaseIdle('t1', lent);
  expect(manager.getByTaskId('t1')).toBe(lent);
  manager.settleByTaskId('t1', lent);
  manager.releaseIdle('t1', lent);
  expect(manager.getByTaskId('t1')).toBeUndefined();
});
