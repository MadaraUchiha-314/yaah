import { describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';

import { StreamHub } from '../stream-hub.ts';
import { EXT, InvalidExtensionError, SCHEMAS, readExtension } from './extensions/index.ts';
import {
  A2aTaskPort,
  UnknownTaskError,
  emptyTaskModel,
  readSettings,
  replyArtifactId,
} from './task-port.ts';
import { MemoryTaskStore } from './task-store.ts';

function setup(metadata?: Record<string, unknown>) {
  const store = new MemoryTaskStore();
  const hub = new StreamHub();
  const port = new A2aTaskPort(store, hub);
  store.update('t1', () => ({
    id: 't1',
    contextId: 'c1',
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: '' },
    history: [],
    artifacts: [],
    metadata,
  }));
  return { store, hub, port };
}

describe('A2aTaskPort', () => {
  test('a task without yaah metadata reads as a blank, short-lived, root task', async () => {
    const { port } = setup();
    const snapshot = await port.load('t1');
    expect(snapshot.model).toEqual(emptyTaskModel());
    expect(snapshot).toMatchObject({
      longRunning: false,
      llm: null,
      effort: null,
      state: 'working',
    });
  });

  test('writes status to the store before publishing it, once per step', async () => {
    const { store, hub, port } = setup();
    const update = {
      state: 'input-required',
      subState: 'awaiting-user-input',
      message: [{ type: 'text', text: 'Which?' }],
    } as const;
    await port.setStatus('t1', 'k1', update);
    await port.setStatus('t1', 'k1', update);
    expect(store.get('t1')?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(store.get('t1')?.history.length).toBe(1);
    expect(hub.replay('t1', 0).filter((entry) => entry.event.type === 'status').length).toBe(1);
    expect((await port.load('t1')).subState).toBe('awaiting-user-input');
  });

  test('stores a reply as an artifact and replaces it when the step repeats', async () => {
    const { store, hub, port } = setup();
    await port.setReply('t1', 'k1', [{ type: 'text', text: 'first attempt' }]);
    await port.setReply('t1', 'k1', [{ type: 'text', text: 'second attempt' }]);
    const artifacts = store.get('t1')?.artifacts ?? [];
    expect(artifacts.map((artifact) => artifact.artifactId)).toEqual([replyArtifactId('k1')]);
    expect(artifacts[0]?.parts[0]?.content).toEqual({ $case: 'text', value: 'second attempt' });
    expect(hub.head('t1')).toBe(2);
  });

  test('a function given as the model is applied to the current one, losing no change', async () => {
    const { port } = setup();
    const add = (taskId: string) => (model: ReturnType<typeof emptyTaskModel>) => ({
      ...model,
      subTasks: [...model.subTasks, { taskId, contextId: 'c', agent: 'a' }],
    });
    await Promise.all([port.setModel('t1', 'k1', add('s1')), port.setModel('t1', 'k2', add('s2'))]);
    const { model } = await port.load('t1');
    expect(model.subTasks.map((ref) => ref.taskId)).toEqual(['s1', 's2']);
  });

  test('settings and the task model live in the task metadata', async () => {
    const { store, port } = setup();
    port.updateSettings('t1', { longRunning: true, llm: 'openai/x', effort: 'high' });
    await port.setModel('t1', 'k', { ...emptyTaskModel(), name: 'Refund' });
    const stored = store.get('t1');
    expect(stored === undefined ? null : readSettings(stored)).toEqual({
      longRunning: true,
      caller: '',
      llm: 'openai/x',
      effort: 'high',
      turnMetadata: {},
    });
    expect(await port.load('t1')).toMatchObject({
      longRunning: true,
      llm: 'openai/x',
      effort: 'high',
    });
    expect((await port.load('t1')).model.name).toBe('Refund');
  });

  test('malformed settings read as the defaults', () => {
    const { store } = setup({ 'yaah.settings': 'nonsense' });
    const stored = store.get('t1');
    expect(stored === undefined ? null : readSettings(stored).longRunning).toBe(false);
  });

  test('an unknown task is an error', async () => {
    const { port } = setup();
    expect(() => port.load('nope')).toThrow(UnknownTaskError);
    let caught: unknown = null;
    try {
      await port.setReply('nope', 'k', []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownTaskError);
  });
});

describe('readExtension', () => {
  test('returns null when the metadata has nothing for the extension', () => {
    expect(readExtension(undefined, EXT.taskLifecycle, SCHEMAS.taskLifecycleRequest)).toBeNull();
    expect(readExtension({ other: 1 }, EXT.taskLifecycle, SCHEMAS.taskLifecycleRequest)).toBeNull();
  });

  test('returns the validated payload', () => {
    expect(
      readExtension(
        { [EXT.taskLifecycle]: { longRunning: true } },
        EXT.taskLifecycle,
        SCHEMAS.taskLifecycleRequest,
      ),
    ).toEqual({ longRunning: true });
  });

  test('rejects a payload that does not match, naming the extension', () => {
    let caught: unknown = null;
    try {
      readExtension(
        { [EXT.taskLifecycle]: { longRunning: 'yes' } },
        EXT.taskLifecycle,
        SCHEMAS.taskLifecycleRequest,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidExtensionError);
    expect(caught instanceof InvalidExtensionError ? caught.uri : '').toBe(EXT.taskLifecycle);
  });

  test('rejects an unknown key, so a typo is not silently ignored', () => {
    expect(() =>
      readExtension(
        { [EXT.taskLifecycle]: { longRuning: true } },
        EXT.taskLifecycle,
        SCHEMAS.taskLifecycleRequest,
      ),
    ).toThrow(InvalidExtensionError);
  });
});
