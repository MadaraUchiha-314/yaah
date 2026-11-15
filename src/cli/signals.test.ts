import { describe, expect, test } from 'bun:test';

import { interrupted } from './signals.ts';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const counts = (): number[] => SIGNALS.map((name) => process.listenerCount(name));

describe('interrupted', () => {
  test('resolves on the first stop request and stops listening for all of them', async () => {
    const before = counts();
    const waiting = interrupted();
    expect(counts()).toEqual(before.map((count) => count + 1));
    process.emit('SIGTERM', 'SIGTERM');
    await waiting;
    expect(counts()).toEqual(before);
  });

  test('stops listening once its signal aborts, and never resolves', async () => {
    const before = counts();
    const left = new AbortController();
    const waiting = interrupted(left.signal).then(() => 'resolved');
    left.abort();
    expect(counts()).toEqual(before);
    process.emit('SIGHUP', 'SIGHUP');
    const pending = new Promise<string>((resolve) => {
      setTimeout(resolve, 10, 'pending');
    });
    expect(await Promise.race([waiting, pending])).toBe('pending');
  });

  test('listens for nothing when its signal has already aborted', () => {
    const before = counts();
    void interrupted(AbortSignal.abort());
    expect(counts()).toEqual(before);
  });
});
