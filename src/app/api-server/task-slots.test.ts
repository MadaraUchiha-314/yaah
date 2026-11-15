import { expect, test } from 'bun:test';

import { TaskSlots } from './task-slots.ts';

test('a slot counts for its caller until released, once (critic 1, #3)', () => {
  const slots = new TaskSlots();
  const first = slots.reserve('a');
  const second = slots.reserve('a');
  slots.reserve('b');
  expect(slots.held('a')).toBe(2);
  expect(slots.held('b')).toBe(1);
  slots.release(first);
  slots.release(first);
  slots.release('unknown');
  expect(slots.held('a')).toBe(1);
  slots.release(second);
  expect(slots.held('a')).toBe(0);
  expect(slots.held('nobody')).toBe(0);
});
