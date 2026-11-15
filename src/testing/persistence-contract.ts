import type { Persistence } from '../harness/core/persistence.ts';
import type { ConversationEventBody, InboxItem, Plan } from '../harness/core/types.ts';
import type { ContractApi } from './contract-api.ts';

const user = (text: string, sourceId: string): ConversationEventBody => ({
  type: 'message',
  role: 'user',
  parts: [{ type: 'text', text }],
  sourceId,
});

const item = (id: string, taskId: string): InboxItem => ({
  id,
  taskId,
  receivedAt: '2026-01-01T00:00:00.000Z',
  interrupt: false,
  payload: { kind: 'message', parts: [{ type: 'text', text: id }] },
});

const plan = (taskId: string, revision: number): Plan => ({
  taskId,
  revision,
  steps: [{ name: 'a', description: 'first', dependsOn: [], status: 'pending', linkedTasks: [] }],
});

function conversationContract(api: ContractApi, create: () => Persistence): void {
  const { describe, expect, test } = api;
  describe('ConversationStore', () => {
    test('returns events in the order they were written, with increasing seq', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('one', 'm1'), user('two', 'm2')]);
      await conversation.put('t1', 't1/1/b/', [user('three', 'm3')]);
      const events = await conversation.read('t1');
      expect(events.map((event) => (event.type === 'message' ? event.sourceId : ''))).toEqual([
        'm1',
        'm2',
        'm3',
      ]);
      expect((events[2]?.seq ?? 0) > (events[1]?.seq ?? 0)).toBe(true);
      expect(events[0]?.key).toBe('t1/0/a/');
    });

    test('a second put under the same key replaces what the first wrote', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('attempt one', 'm1')]);
      await conversation.put('t1', 't1/0/a/', [user('attempt two', 'm1')]);
      const events = await conversation.read('t1');
      expect(events.length).toBe(1);
      expect(events[0]?.type === 'message' ? events[0].parts : []).toEqual([
        { type: 'text', text: 'attempt two' },
      ]);
    });

    test('events rewritten by a step keep their place in the conversation', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('first', 'm1')]);
      await conversation.put('t1', 't1/1/b/', [user('second', 'm2')]);
      await conversation.put('t1', 't1/0/a/', [user('first again', 'm1'), user('extra', 'm1b')]);
      const events = await conversation.read('t1');
      expect(events.map((event) => (event.type === 'message' ? event.sourceId : ''))).toEqual([
        'm1',
        'm2',
        'm1b',
      ]);
    });

    test('putting an empty list under a key removes its events', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('gone', 'm1')]);
      await conversation.put('t1', 't1/0/a/', []);
      expect(await conversation.read('t1')).toEqual([]);
    });

    test('keeps tasks apart', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('for t1', 'm1')]);
      expect(await conversation.read('t2')).toEqual([]);
    });

    test('reads a half-open sequence range', async () => {
      const { conversation } = create();
      await conversation.put('t1', 't1/0/a/', [user('0', 'a'), user('1', 'b'), user('2', 'c')]);
      const all = await conversation.read('t1');
      const from = all[1]?.seq ?? 0;
      const ranged = await conversation.read('t1', { from, to: from + 1 });
      expect(ranged.length).toBe(1);
      expect(ranged[0]?.seq).toBe(from);
    });
  });
}

function stateAndPlanContract(api: ContractApi, create: () => Persistence): void {
  const { describe, expect, test } = api;
  describe('StateStore', () => {
    test('returns undefined for a name never set', async () => {
      expect(await create().state.get('t1', 'missing')).toBeUndefined();
    });

    test('stores a value per task and name, and lists the names sorted', async () => {
      const { state } = create();
      await state.set('t1', 't1/0/s/b', 'b', { n: 1 });
      await state.set('t1', 't1/1/s/a', 'a', [true, null]);
      expect(await state.get('t1', 'b')).toEqual({ n: 1 });
      expect(await state.get('t2', 'b')).toBeUndefined();
      expect(await state.names('t1')).toEqual(['a', 'b']);
    });

    test('a later step overwrites; the same step repeated does not', async () => {
      const { state } = create();
      await state.set('t1', 't1/0/s/x', 'x', 1);
      await state.set('t1', 't1/1/s/x', 'x', 2);
      await state.set('t1', 't1/0/s/x', 'x', 1);
      expect(await state.get('t1', 'x')).toBe(2);
    });
  });

  describe('PlanStore', () => {
    test('returns undefined before a plan is saved', async () => {
      expect(await create().plan.load('t1')).toBeUndefined();
    });

    test('loads the last saved plan, and a repeated save of an older step is ignored', async () => {
      const store = create().plan;
      await store.save('t1/0/p/', plan('t1', 1));
      await store.save('t1/1/p/', plan('t1', 2));
      await store.save('t1/0/p/', plan('t1', 1));
      expect((await store.load('t1'))?.revision).toBe(2);
    });
  });
}

function inboxAndJournalContract(api: ContractApi, create: () => Persistence): void {
  const { describe, expect, test } = api;
  describe('InboxStore', () => {
    test('stores an item once and reports a duplicate', async () => {
      const { inbox } = create();
      expect(await inbox.put(item('m1', 't1'))).toBe('stored');
      expect(await inbox.put(item('m1', 't1'))).toBe('duplicate');
      expect((await inbox.pending('t1')).length).toBe(1);
    });

    test('lists pending items in arrival order, per task or for all', async () => {
      const { inbox } = create();
      await inbox.put(item('m1', 't1'));
      await inbox.put(item('m2', 't2'));
      await inbox.put(item('m3', 't1'));
      expect((await inbox.pending('t1')).map((entry) => entry.id)).toEqual(['m1', 'm3']);
      expect((await inbox.pending()).map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3']);
    });

    test('a processed item is no longer pending but can still be fetched', async () => {
      const { inbox } = create();
      await inbox.put(item('m1', 't1'));
      await inbox.markProcessed(['m1']);
      await inbox.markProcessed(['m1']);
      expect(await inbox.pending('t1')).toEqual([]);
      expect((await inbox.get(['m1', 'unknown'])).map((entry) => entry.id)).toEqual(['m1']);
    });

    test('a processed item delivered again is still a duplicate', async () => {
      const { inbox } = create();
      await inbox.put(item('m1', 't1'));
      await inbox.markProcessed(['m1']);
      expect(await inbox.put(item('m1', 't1'))).toBe('duplicate');
      expect(await inbox.pending('t1')).toEqual([]);
    });
  });

  describe('StepJournal', () => {
    test('returns undefined for a step that was never recorded', async () => {
      expect(await create().journal.get('t1/0/x/')).toBeUndefined();
    });

    test('the first record for a key wins', async () => {
      const { journal } = create();
      await journal.record('t1/0/x/', { attempt: 1 });
      await journal.record('t1/0/x/', { attempt: 2 });
      expect((await journal.get('t1/0/x/'))?.result).toEqual({ attempt: 1 });
    });

    test('lists the records of one task in recording order', async () => {
      const { journal } = create();
      await journal.record('t1/0/x/', 1);
      await journal.record('t2/0/x/', 2);
      await journal.record('t1/1/y/', 3);
      expect((await journal.list('t1')).map((record) => record.key)).toEqual([
        't1/0/x/',
        't1/1/y/',
      ]);
    });
  });
}

/**
 * The contract every persistence backend must keep — in particular replace-by-key,
 * which is what makes a retried step safe. Run it against your own backend before
 * plugging it in.
 *
 * @param create Returns a fresh, empty backend for each test.
 */
export function persistenceContract(api: ContractApi, create: () => Persistence): void {
  api.describe('persistence contract', () => {
    conversationContract(api, create);
    stateAndPlanContract(api, create);
    inboxAndJournalContract(api, create);
  });
}
