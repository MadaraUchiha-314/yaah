import { afterAll, describe, expect, test } from 'bun:test';
import type { Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';

import { openDatabase } from '../../harness/core/sqlite-driver.ts';
import type { YaahTaskStore } from './task-store.ts';
import { MemoryTaskStore, SqliteTaskStore, handlerFacing } from './task-store.ts';

const context = new ServerCallContext();
const database = openDatabase(':memory:');

afterAll(() => {
  database.close();
});

function task(
  id: string,
  state: TaskState,
  contextId = 'c1',
  timestamp = '2026-01-01T00:00:00Z',
): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp },
    artifacts: [
      {
        artifactId: 'a1',
        name: 'response',
        description: '',
        parts: [
          {
            content: { $case: 'raw', value: Buffer.from('hi') },
            metadata: undefined,
            filename: 'f',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [message('m1'), message('m2')],
    metadata: { key: { nested: true } },
  };
}

function message(messageId: string) {
  return {
    messageId,
    contextId: 'c1',
    taskId: 't1',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text' as const, value: messageId },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

const stores: [string, () => YaahTaskStore][] = [
  ['memory', () => new MemoryTaskStore()],
  [
    'sqlite',
    () => {
      database.exec('DROP TABLE IF EXISTS a2a_tasks');
      return new SqliteTaskStore(database);
    },
  ],
];

for (const [name, create] of stores) {
  describe(`task store: ${name}`, () => {
    test('saves and loads a task, bytes and metadata included', async () => {
      const store = create();
      await store.save(task('t1', TaskState.TASK_STATE_WORKING), context);
      const loaded = await store.load('t1', context);
      expect(loaded?.metadata).toEqual({ key: { nested: true } });
      const [part] = loaded?.artifacts[0]?.parts ?? [];
      expect(part?.content?.$case === 'raw' ? Buffer.from(part.content.value).toString() : '').toBe(
        'hi',
      );
      expect(await store.load('nope', context)).toBeUndefined();
    });

    test('update is read-modify-write, and can create or decline', () => {
      const store = create();
      expect(store.update('t1', () => undefined)).toBeUndefined();
      store.update('t1', (current) => current ?? task('t1', TaskState.TASK_STATE_WORKING));
      const changed = store.update('t1', (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: 'x' },
            },
      );
      expect(changed?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    });

    test('open lists only tasks that are not terminal', async () => {
      const store = create();
      await store.save(task('t1', TaskState.TASK_STATE_WORKING), context);
      await store.save(task('t2', TaskState.TASK_STATE_INPUT_REQUIRED), context);
      await store.save(task('t3', TaskState.TASK_STATE_COMPLETED), context);
      await store.save(task('t4', TaskState.TASK_STATE_CANCELED), context);
      expect(
        store
          .open()
          .map((entry) => entry.id)
          .toSorted(),
      ).toEqual(['t1', 't2']);
    });

    test('list filters by context and state, pages, and trims history and artifacts', async () => {
      const store = create();
      await store.save(
        task('t1', TaskState.TASK_STATE_WORKING, 'c1', '2026-01-01T00:00:01Z'),
        context,
      );
      await store.save(
        task('t2', TaskState.TASK_STATE_COMPLETED, 'c1', '2026-01-01T00:00:02Z'),
        context,
      );
      await store.save(
        task('t3', TaskState.TASK_STATE_WORKING, 'c2', '2026-01-01T00:00:03Z'),
        context,
      );
      const base = {
        tenant: '',
        contextId: '',
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
      };
      const all = await store.list(base, context);
      expect(all.tasks.map((entry) => entry.id)).toEqual(['t3', 't2', 't1']);
      expect(all.totalSize).toBe(3);
      expect(all.tasks[0]?.artifacts).toEqual([]);

      const inContext = await store.list(
        { ...base, contextId: 'c1', status: TaskState.TASK_STATE_WORKING },
        context,
      );
      expect(inContext.tasks.map((entry) => entry.id)).toEqual(['t1']);

      const firstPage = await store.list(
        { ...base, pageSize: 2, historyLength: 1, includeArtifacts: true },
        context,
      );
      expect(firstPage.tasks.length).toBe(2);
      expect(firstPage.nextPageToken).toBe('2');
      expect(firstPage.tasks[0]?.history.map((entry) => entry.messageId)).toEqual(['m2']);
      expect(firstPage.tasks[0]?.artifacts.length).toBe(1);
      const secondPage = await store.list(
        { ...base, pageSize: 2, pageToken: firstPage.nextPageToken },
        context,
      );
      expect(secondPage.tasks.map((entry) => entry.id)).toEqual(['t1']);
      expect(secondPage.nextPageToken).toBe('');

      const recent = await store.list(
        { ...base, statusTimestampAfter: '2026-01-01T00:00:02Z' },
        context,
      );
      expect(recent.tasks.map((entry) => entry.id)).toEqual(['t3']);
    });
  });
}

describe('handlerFacing', () => {
  test('creates a task that does not exist yet', async () => {
    const store = new MemoryTaskStore();
    await handlerFacing(store).save(task('t1', TaskState.TASK_STATE_SUBMITTED), context);
    expect((await store.load('t1'))?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  });

  test('a save computed from a stale read adds history but cannot undo a newer status', async () => {
    const store = new MemoryTaskStore();
    await store.save(task('t1', TaskState.TASK_STATE_WORKING));
    const facing = handlerFacing(store);
    const stale = await facing.load('t1', context);
    store.update('t1', (current) =>
      current === undefined
        ? undefined
        : {
            ...current,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: 'later',
            },
            artifacts: [],
          },
    );
    await facing.save(
      {
        ...task('t1', TaskState.TASK_STATE_WORKING),
        history: [...(stale?.history ?? []), message('m3')],
      },
      context,
    );
    const result = await store.load('t1');
    expect(result?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(result?.artifacts).toEqual([]);
    expect(result?.history.map((entry) => entry.messageId)).toEqual(['m1', 'm2', 'm3']);
  });

  test('load and list pass through', async () => {
    const store = new MemoryTaskStore();
    await store.save(task('t1', TaskState.TASK_STATE_WORKING));
    const facing = handlerFacing(store);
    expect((await facing.load('t1', context))?.id).toBe('t1');
    const listed = await facing.list(
      {
        tenant: '',
        contextId: '',
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
      },
      context,
    );
    expect(listed.totalSize).toBe(1);
  });
});
