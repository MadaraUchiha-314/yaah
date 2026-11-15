import { describe, expect, test } from 'bun:test';

import { DEFAULT_BACKOFF, backoffDelay, resolveBackoff } from './backoff.ts';

describe('backoffDelay', () => {
  test('starts at one second and doubles', () => {
    const delays = [0, 1, 2, 3].map((failures) => backoffDelay(failures, DEFAULT_BACKOFF));
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  test('never exceeds the cap', () => {
    expect(backoffDelay(6, DEFAULT_BACKOFF)).toBe(60_000);
    expect(backoffDelay(5000, DEFAULT_BACKOFF)).toBe(60_000);
  });

  test('uses the configured delays', () => {
    const backoff = { initialMs: 5, factor: 3, maxMs: 40 };
    expect([0, 1, 2].map((failures) => backoffDelay(failures, backoff))).toEqual([5, 15, 40]);
  });
});

describe('resolveBackoff', () => {
  test('fills what is not given from the defaults', () => {
    expect(resolveBackoff()).toEqual(DEFAULT_BACKOFF);
    expect(resolveBackoff({ initialMs: 5 })).toEqual({ initialMs: 5, factor: 2, maxMs: 60_000 });
  });
});
