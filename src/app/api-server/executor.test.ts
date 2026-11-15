import { describe, expect, test } from 'bun:test';
import type { Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus } from '@a2a-js/sdk/server';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';

import type { DurableExecution } from '../durable/types.ts';
import { Inbox } from '../inbox/inbox.ts';
import { createMemoryPersistence } from '../../harness/core/memory-persistence.ts';
import { StreamHub } from '../stream-hub.ts';
import { HarnessExecutor } from './executor.ts';
import { A2aTaskPort } from './task-port.ts';
import { MemoryTaskStore } from './task-store.ts';

function collect(bus: ExecutionEventBus): {
  events: AgentExecutionEvent[];
  finished: () => boolean;
} {
  const events: AgentExecutionEvent[] = [];
  let done = false;
  bus.on('event', (event) => {
    events.push(event);
  });
  bus.on('finished', () => {
    done = true;
  });
  return { events, finished: () => done };
}

function request(taskId: string, task?: Task): RequestContext {
  const message = {
    messageId: `m-${String(Math.random())}`,
    contextId: 'c1',
    taskId,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text' as const, value: 'hi' },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  return new RequestContext(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    taskId,
    'c1',
    new ServerCallContext(),
    task,
  );
}

function setup(
  onDeliver: (deps: { tasks: A2aTaskPort; hub: StreamHub }) => void | Promise<void>,
  backstopMs = 15,
) {
  const store = new MemoryTaskStore();
  const hub = new StreamHub();
  const tasks = new A2aTaskPort(store, hub);
  const durable: DurableExecution = {
    mode: 'none',
    deliver: async () => {
      await onDeliver({ tasks, hub });
    },
    cancel: () =>
      tasks.setStatus('t1', 'cancel-step', { state: 'canceled', subState: null, message: [] }),
    recover: () => Promise.resolve(),
    dashboard: () => null,
    taskUrl: () => null,
    close: () => Promise.resolve(),
  };
  const inbox = new Inbox(createMemoryPersistence().inbox, durable);
  const executor = new HarnessExecutor({
    store,
    hub,
    inbox,
    durable,
    tasks,
    agentId: 'self',
    backstopMs,
  });
  return { store, hub, tasks, executor };
}

describe('HarnessExecutor', () => {
  test('streams deltas, a retry reset and the final artifact, then the resting status', async () => {
    const { executor } = setup(({ tasks, hub }) => {
      hub.delta('t1', 'k-llm', 'Hel');
      hub.reset('t1', 'k-llm');
      hub.delta('t1', 'k-llm', 'Hello');
      void tasks.setReply('t1', 'k-llm', [{ type: 'text', text: 'Hello' }]);
      void tasks.setStatus('t1', 'k-done', { state: 'completed', subState: null, message: [] });
    });
    const bus = new DefaultExecutionEventBus();
    const seen = collect(bus);
    await executor.execute(request('t1'), bus);
    expect(seen.events.map((event) => event.kind)).toEqual([
      'task',
      'artifactUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    const [, first, reset, , final] = seen.events;
    expect(first?.kind === 'artifactUpdate' ? first.data.append : null).toBe(true);
    expect(
      reset?.kind === 'artifactUpdate'
        ? [reset.data.append, reset.data.artifact?.parts.length]
        : null,
    ).toEqual([false, 0]);
    expect(
      final?.kind === 'artifactUpdate' ? [final.data.append, final.data.lastChunk] : null,
    ).toEqual([false, true]);
    expect(seen.finished()).toBe(true);
  });

  test('when the stream is silent, the task store decides that the turn is over', async () => {
    const { executor, store } = setup(() => {
      // The status reaches the store but never the hub — as if the event had been missed.
      setTimeout(() => {
        store.update('t1', (task) =>
          task === undefined
            ? undefined
            : {
                ...task,
                status: {
                  state: TaskState.TASK_STATE_COMPLETED,
                  message: undefined,
                  timestamp: 'now',
                },
                metadata: { ...task.metadata, 'yaah.status-step': 'elsewhere' },
              },
        );
      }, 5);
    });
    const bus = new DefaultExecutionEventBus();
    const seen = collect(bus);
    await executor.execute(request('t1'), bus);
    const last = seen.events.at(-1);
    expect(last?.kind === 'statusUpdate' ? last.data.status?.state : null).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    expect(seen.finished()).toBe(true);
  });

  test('a failure while handing over is recorded as the task failing', async () => {
    const { executor, store } = setup(() => {
      throw new Error('inbox store is down');
    });
    const bus = new DefaultExecutionEventBus();
    const seen = collect(bus);
    await executor.execute(request('t1'), bus);
    expect(store.get('t1')?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const last = seen.events.at(-1);
    expect(last?.kind === 'statusUpdate' ? last.data.status?.state : null).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    expect(seen.finished()).toBe(true);
  });

  test('cancelTask on an unknown task finishes quietly', async () => {
    const { executor } = setup(() => undefined);
    const bus = new DefaultExecutionEventBus();
    const seen = collect(bus);
    await executor.cancelTask('nope', bus);
    expect(seen.events).toEqual([]);
    expect(seen.finished()).toBe(true);
  });

  test('cancelTask cancels the run and streams the canceled status', async () => {
    const { executor, store } = setup(() => undefined);
    store.update('t1', () => ({
      id: 't1',
      contextId: 'c1',
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: '' },
      history: [],
      artifacts: [],
      metadata: undefined,
    }));
    const bus = new DefaultExecutionEventBus();
    const seen = collect(bus);
    await executor.cancelTask('t1', bus);
    const last = seen.events.at(-1);
    expect(last?.kind === 'statusUpdate' ? last.data.status?.state : null).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
  });
});
