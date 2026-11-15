import { describe, expect, test } from 'bun:test';

import type { SequencedHubEvent } from './stream-hub.ts';
import { StreamHub } from './stream-hub.ts';

const delta = (text: string) => ({ type: 'delta' as const, key: 'k', text });

async function take(
  hub: StreamHub,
  taskId: string,
  afterSeq: number,
  count: number,
): Promise<SequencedHubEvent[]> {
  const controller = new AbortController();
  const seen: SequencedHubEvent[] = [];
  for await (const event of hub.subscribe(taskId, afterSeq, controller.signal)) {
    seen.push(event);
    if (seen.length === count) {
      controller.abort();
    }
  }
  return seen;
}

describe('StreamHub', () => {
  test('numbers events per task from 1 and reports the head', () => {
    const hub = new StreamHub();
    expect(hub.head('t1')).toBe(0);
    expect(hub.publish('t1', delta('a'))).toBe(1);
    expect(hub.publish('t1', delta('b'))).toBe(2);
    expect(hub.publish('t2', delta('c'))).toBe(1);
    expect(hub.head('t1')).toBe(2);
  });

  test('a subscriber that starts before a publish sees it', async () => {
    const hub = new StreamHub();
    const pending = take(hub, 't1', hub.head('t1'), 2);
    hub.publish('t1', delta('a'));
    hub.publish('t1', delta('b'));
    expect((await pending).map((event) => event.seq)).toEqual([1, 2]);
  });

  test('replays everything after the given sequence number, then follows live', async () => {
    const hub = new StreamHub();
    hub.publish('t1', delta('a'));
    hub.publish('t1', delta('b'));
    const pending = take(hub, 't1', 1, 2);
    hub.publish('t1', delta('c'));
    const seen = await pending;
    expect(seen.map((event) => (event.event.type === 'delta' ? event.event.text : ''))).toEqual([
      'b',
      'c',
    ]);
  });

  test('a fast run that finished before the subscriber read is not lost', async () => {
    const hub = new StreamHub();
    const start = hub.head('t1');
    hub.publish('t1', delta('all'));
    hub.publish('t1', { type: 'status', state: 'completed', subState: null, messageId: 'm' });
    expect((await take(hub, 't1', start, 2)).length).toBe(2);
  });

  test('keeps tasks apart', async () => {
    const hub = new StreamHub();
    hub.publish('t2', delta('other'));
    const pending = take(hub, 't1', 0, 1);
    hub.publish('t1', delta('mine'));
    const [only] = await pending;
    expect(only?.event.type === 'delta' ? only.event.text : '').toBe('mine');
  });

  test('bounds the log, dropping the oldest events', () => {
    const hub = new StreamHub(3);
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      hub.publish('t1', delta(text));
    }
    expect(hub.head('t1')).toBe(5);
    expect(hub.replay('t1', 0).map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  test('clear drops a task log but keeps numbering monotonic', () => {
    const hub = new StreamHub();
    hub.publish('t1', delta('a'));
    hub.clear('t1');
    expect(hub.replay('t1', 0)).toEqual([]);
    expect(hub.publish('t1', delta('b'))).toBe(2);
  });

  test('an aborted subscription ends', async () => {
    const hub = new StreamHub();
    const controller = new AbortController();
    const pending = (async (): Promise<number> => {
      let count = 0;
      for await (const event of hub.subscribe('t1', 0, controller.signal)) {
        count += event.seq;
      }
      return count;
    })();
    controller.abort();
    expect(await pending).toBe(0);
  });

  test('drops a finished task log a while after its final status (self-review 1, core #8)', async () => {
    const hub = new StreamHub(2000, 20);
    hub.publish('t1', delta('all'));
    hub.publish('t1', { type: 'status', state: 'completed', subState: null, messageId: 'm' });
    hub.publish('t2', { type: 'status', state: 'input-required', subState: null, messageId: 'm' });
    // A subscriber that comes right after still gets the final events.
    expect((await take(hub, 't1', 0, 2)).length).toBe(2);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(hub.replay('t1', 0)).toEqual([]);
    // A task that is only waiting keeps its log.
    expect(hub.replay('t2', 0)).toHaveLength(1);
    expect(hub.size).toBe(1);
  });

  test('following a task nobody has published for leaves nothing behind', async () => {
    const hub = new StreamHub();
    // A subscriber waiting for a task's first event still gets it.
    const pending = take(hub, 'new', 0, 1);
    hub.publish('new', delta('a'));
    expect((await pending).length).toBe(1);
    // One that gives up before anything is published leaves no log behind.
    const controller = new AbortController();
    const ghost = (async (): Promise<number> => {
      let count = 0;
      for await (const event of hub.subscribe('ghost', 0, controller.signal)) {
        count += event.seq;
      }
      return count;
    })();
    controller.abort();
    expect(await ghost).toBe(0);
    expect(hub.size).toBe(1);
  });
});
