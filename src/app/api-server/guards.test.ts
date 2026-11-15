import { expect, test } from 'bun:test';

import type { GuardDeps } from './guards.ts';
import { RequestRate, callerKey, knownHost } from './guards.ts';

const socket = { remoteAddress: '10.0.0.2' };

test('the caller is the address Express worked out, else the socket address', () => {
  // Express sets `ip` from its `trust proxy` setting; the guard does not read headers itself.
  expect(callerKey({ ip: '203.0.113.7', socket })).toBe('203.0.113.7');
  expect(callerKey({ socket })).toBe('10.0.0.2');
  expect(callerKey({ socket: {} })).toBe('unknown');
});

test('a caller whose requests have all left the minute is forgotten', () => {
  const rate = new RequestRate();
  expect(rate.hit('a', 1000, 10)).toBe(true);
  expect(rate.hit('b', 2000, 10)).toBe(true);
  expect(rate.hit('a', 3000, 10)).toBe(true);
  expect(rate.stored('a')).toBe(2);
  expect(rate.size).toBe(2);
  // A minute after a's last request and b's: both are gone, c is counted afresh.
  expect(rate.hit('c', 64_000, 10)).toBe(true);
  expect(rate.size).toBe(1);
  expect(rate.hit('a', 64_001, 10)).toBe(true);
  expect(rate.stored('a')).toBe(1);
  expect(rate.stored('nobody')).toBe(0);
});

test('a flood stores no more than the limit, so each hit costs the same (self-review 2, #6)', () => {
  const rate = new RequestRate();
  const limit = 5;
  const allowed = Array.from({ length: 10_000 }, (_, index) => rate.hit('a', 1000 + index, limit));
  expect(allowed.filter(Boolean)).toHaveLength(limit);
  expect(rate.stored('a')).toBe(limit);
  // Once the first requests leave the minute, the caller may send again.
  expect(rate.hit('a', 61_000, limit)).toBe(true);
  expect(rate.hit('a', 61_001, limit)).toBe(true);
  expect(rate.stored('a')).toBe(limit);
});

test('a Host without a port names port 80, in any case (self-review 2, #7)', () => {
  const deps = (host: string, port: number, allowedOrigins: string[] = []): GuardDeps => ({
    limits: { maxParts: 1, maxPartBytes: 1, maxOpenTasksPerCaller: 1, maxRequestsPerMinute: 1 },
    allowedOrigins,
    listener: () => ({ host, port }),
    openTasks: () => 0,
  });
  expect(knownHost('localhost', deps('127.0.0.1', 80))).toBe(true);
  expect(knownHost('LocalHost:80', deps('127.0.0.1', 80))).toBe(true);
  expect(knownHost('localhost', deps('127.0.0.1', 7420))).toBe(false);
  expect(knownHost('Harness.Example', deps('harness.example', 80))).toBe(true);
  expect(knownHost('[::1]:7420', deps('::', 7420))).toBe(true);
  expect(knownHost('localhost:7421', deps('0.0.0.0', 7420))).toBe(false);
  // An allowed origin matches with or without its default port, and only on its own port.
  const allowed = deps('127.0.0.1', 7420, ['https://App.example', 'http://other.example:8080']);
  expect(knownHost('app.example', allowed)).toBe(true);
  expect(knownHost('app.example:443', allowed)).toBe(true);
  expect(knownHost('app.example:8443', allowed)).toBe(false);
  expect(knownHost('other.example:8080', allowed)).toBe(true);
  expect(knownHost('other.example', allowed)).toBe(false);
  expect(knownHost('evil.example', allowed)).toBe(false);
  expect(knownHost('', allowed)).toBe(false);
});
