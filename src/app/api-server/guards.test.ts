import { expect, test } from 'bun:test';

import { RequestRate, callerKey } from './guards.ts';

const socket = { remoteAddress: '10.0.0.2' };

test('behind a trusted proxy the caller is the address the proxy appended, not the first', () => {
  const headers = { 'x-forwarded-for': '198.51.100.1, 203.0.113.7 ' };
  expect(callerKey({ headers, socket }, true)).toBe('203.0.113.7');
  expect(callerKey({ headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }, socket }, true)).toBe(
    '2.2.2.2',
  );
  // Not trusted, or nothing forwarded: the socket's own address.
  expect(callerKey({ headers, socket }, false)).toBe('10.0.0.2');
  expect(callerKey({ headers: { 'x-forwarded-for': ' , ' }, socket }, true)).toBe('10.0.0.2');
  expect(callerKey({ headers: {}, socket: {} }, false)).toBe('unknown');
});

test('a caller whose requests have all left the minute is forgotten', () => {
  const rate = new RequestRate();
  expect(rate.hit('a', 1000)).toBe(1);
  expect(rate.hit('b', 2000)).toBe(1);
  expect(rate.hit('a', 3000)).toBe(2);
  expect(rate.size).toBe(2);
  // A minute after a's last request and b's: both are gone, c is counted afresh.
  expect(rate.hit('c', 64_000)).toBe(1);
  expect(rate.size).toBe(1);
  expect(rate.hit('a', 64_001)).toBe(1);
});
