import { describe, expect, test } from 'bun:test';

import type { AsyncQueue } from './async-queue.ts';
import { createAsyncQueue } from './async-queue.ts';

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of queue) {
    seen.push(value);
  }
  return seen;
}

describe('AsyncQueue', () => {
  test('yields what was pushed before the reader came, in order, then ends', async () => {
    const queue = createAsyncQueue<number>();
    for (const value of [1, 2]) {
      queue.push(value);
    }
    queue.end();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  test('wakes a waiting reader on every push', async () => {
    const queue = createAsyncQueue<string>();
    const reading = drain(queue);
    await Promise.resolve();
    queue.push('a');
    await Promise.resolve();
    queue.push('b');
    queue.end();
    expect(await reading).toEqual(['a', 'b']);
  });

  test('a failure reaches the reader after the values already pushed', async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.fail(new Error('broken'));
    queue.push(2);
    queue.fail(new Error('again'));
    const seen: number[] = [];
    let caught: unknown = null;
    try {
      for await (const value of queue) {
        seen.push(value);
      }
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual([1]);
    expect(caught instanceof Error && caught.message).toBe('broken');
  });

  test('a value pushed while another is being read is not lost when the queue then ends', async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    for await (const value of queue) {
      seen.push(value);
      if (value === 1) {
        queue.push(2);
        queue.end();
      }
    }
    expect(seen).toEqual([1, 2]);
  });

  test('nothing is taken after the end, and ending twice is harmless', async () => {
    const queue = createAsyncQueue<number>();
    queue.end();
    queue.push(1);
    queue.fail(new Error('late'));
    queue.end();
    expect(await drain(queue)).toEqual([]);
  });
});
