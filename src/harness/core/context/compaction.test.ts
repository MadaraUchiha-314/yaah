import { describe, expect, test } from 'bun:test';

import type { ConversationEvent, ConversationEventBody } from '../types.ts';
import { ScriptedLlm, say } from '../../../testing/scripted-llm.ts';
import { defaultCompactionStrategy } from './compaction.ts';

// About 100 tokens per event.
const pad = 'x'.repeat(400);

function events(...bodies: (ConversationEventBody & { key?: string })[]): ConversationEvent[] {
  return bodies.map((body, seq) => ({ key: `k${String(seq)}`, ...body, seq }));
}

const user = (label: string, pinned = false): ConversationEventBody => ({
  type: 'message',
  role: 'user',
  parts: [{ type: 'text', text: `${label} ${pad}` }],
  sourceId: label,
  pinned,
});

const agent = (label: string, key: string): ConversationEventBody & { key: string } => ({
  type: 'message',
  role: 'agent',
  parts: [{ type: 'text', text: `${label} ${pad}` }],
  sourceId: key,
  key,
});

const toolCall = (id: string, key: string): ConversationEventBody & { key: string } => ({
  type: 'tool-call',
  call: { id, name: 'tool', args: { pad } },
  key,
});

const result = (callId: string): ConversationEventBody => ({
  type: 'tool-result',
  callId,
  result: { ok: true, content: [{ type: 'text', text: pad }] },
});

describe('defaultCompactionStrategy.select', () => {
  test('replaces the oldest turns and keeps the most recent ones within the budget', () => {
    const list = events(
      user('u1'),
      agent('a1', 'l1'),
      user('u2'),
      agent('a2', 'l2'),
      user('u3'),
      agent('a3', 'l3'),
    );
    expect(defaultCompactionStrategy.select(list, 250)).toEqual({ from: 0, to: 4 });
  });

  test('never splits a model turn from its tool results', () => {
    const list = events(
      user('u1'),
      toolCall('c1', 'l1'),
      result('c1'),
      agent('a1', 'l2'),
      user('u2'),
      agent('a2', 'l3'),
    );
    // A budget that would cut in the middle of the first turn moves the cut to its end.
    const range = defaultCompactionStrategy.select(list, 350);
    expect(range).toEqual({ from: 0, to: 4 });
  });

  test('never replaces a tool call of the newest model turn that has no result yet', () => {
    const list = events(
      user('u1'),
      agent('a1', 'l1'),
      user('u2'),
      toolCall('c1', 'l2'),
      // An event that arrives while the call waits does not make it older.
      { type: 'event', sourceId: 'e1', event: { pad } },
      { type: 'event', sourceId: 'e2', event: { pad } },
    );
    expect(defaultCompactionStrategy.select(list, 150)).toEqual({ from: 0, to: 2 });
  });

  test('replaces a call an interrupt left without a result, once the model has moved on', () => {
    // self-review 1, core #6: the abandoned call c1 must not stop compaction for good.
    const list = events(
      user('u1'),
      agent('a1', 'l1'),
      user('u2'),
      toolCall('c1', 'l2'),
      user('u3'),
      agent('a3', 'l3'),
      user('u4'),
      agent('a4', 'l4'),
    );
    expect(defaultCompactionStrategy.select(list, 250)).toEqual({ from: 0, to: 6 });
  });

  test('never replaces a pinned message', () => {
    const list = events(
      user('u1'),
      agent('a1', 'l1'),
      user('u2', true),
      agent('a2', 'l2'),
      user('u3'),
      agent('a3', 'l3'),
    );
    expect(defaultCompactionStrategy.select(list, 150)).toEqual({ from: 0, to: 2 });
  });

  test('returns null when nothing can be replaced', () => {
    expect(
      defaultCompactionStrategy.select(events(user('u1'), agent('a1', 'l1')), 10_000),
    ).toBeNull();
    expect(
      defaultCompactionStrategy.select(events(user('u1', true), agent('a1', 'l1')), 1),
    ).toBeNull();
    expect(defaultCompactionStrategy.select([], 1)).toBeNull();
  });

  test('folds an earlier summary into the new one', () => {
    const list: ConversationEvent[] = [
      ...events(user('u1'), agent('a1', 'l1'), user('u2'), agent('a2', 'l2'), user('u3')).slice(2),
      { type: 'summary', replaces: { from: 0, to: 2 }, text: `old ${pad}`, seq: 5, key: 'c1' },
      { ...agent('a3', 'l3'), seq: 6 },
      { ...user('u4'), seq: 7, key: 'k7' },
      { ...agent('a4', 'l4'), seq: 8 },
    ];
    expect(defaultCompactionStrategy.select(list, 250)).toEqual({ from: 0, to: 7 });
  });
});

describe('defaultCompactionStrategy.summarize', () => {
  test('gives the model the instructions and a transcript of every kind of event', async () => {
    const llm = new ScriptedLlm([say('  A short summary.  ')]);
    const span = events(
      user('u1'),
      toolCall('c1', 'l1'),
      result('c1'),
      { type: 'event', sourceId: 'e1', event: { state: 'done' } },
      { type: 'summary', replaces: { from: 0, to: 0 }, text: 'older' },
      { type: 'reasoning', opaque: { provider: 'p', data: 'hidden' } },
    );
    const text = await defaultCompactionStrategy.summarize(
      span,
      llm,
      'INSTRUCTIONS',
      new AbortController().signal,
    );
    expect(text).toBe('A short summary.');
    const [request] = llm.requests;
    expect(request?.tools).toEqual([]);
    const shown = JSON.stringify(request?.messages);
    expect(shown).toContain('INSTRUCTIONS');
    for (const expected of [
      'user: u1',
      'tool call tool',
      'tool result',
      'event:',
      'earlier summary: older',
    ]) {
      expect(shown).toContain(expected);
    }
    expect(shown).not.toContain('hidden');
  });
});
