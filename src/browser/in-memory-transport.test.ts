import type { AgentCard, StreamResponse, Task } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import { ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { STATE_HEADERS_KEY } from '@a2a-js/sdk/server';
import { describe, expect, test } from 'bun:test';

import { IN_MEMORY_PROTOCOL, InMemoryTransport, connectInMemory } from './in-memory-transport.ts';

const CARD: AgentCard = {
  name: 'fake',
  description: 'A handler that records what it is asked.',
  supportedInterfaces: [],
  provider: undefined,
  version: '1',
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [],
  signatures: [],
};

const TASK: Task = {
  id: 't1',
  contextId: 'c1',
  status: undefined,
  artifacts: [],
  history: [],
  metadata: { nested: { n: 1 } },
};

const taskEvent = (): StreamResponse => ({ payload: { $case: 'task', value: TASK } });

/** A request handler that answers every call with the same objects and records the calls. */
function fake(): {
  handler: A2ARequestHandler;
  calls: [string, unknown, ServerCallContext][];
  stream: { returned: boolean; release: () => void };
} {
  const calls: [string, unknown, ServerCallContext][] = [];
  const stream = { returned: false, release: (): void => undefined };
  const answer =
    <T>(method: string, value: T) =>
    (params: unknown, context: ServerCallContext): Promise<T> => {
      calls.push([method, params, context]);
      return Promise.resolve(value);
    };
  const config = {
    tenant: '',
    taskId: 't1',
    id: 'p1',
    url: '',
    token: '',
    authentication: undefined,
  };
  async function* events(
    method: string,
    params: unknown,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    calls.push([method, params, context]);
    try {
      yield taskEvent();
      await new Promise<void>((resolve) => {
        stream.release = resolve;
      });
      yield taskEvent();
    } finally {
      stream.returned = true;
    }
  }
  const handler: A2ARequestHandler = {
    getAgentCard: () => Promise.resolve(CARD),
    getAuthenticatedExtendedAgentCard: answer('extendedCard', CARD),
    sendMessage: answer('sendMessage', TASK),
    sendMessageStream: (params, context) => events('sendMessageStream', params, context),
    getTask: answer('getTask', TASK),
    cancelTask: answer('cancelTask', TASK),
    createTaskPushNotificationConfig: answer('createPush', config),
    getTaskPushNotificationConfig: answer('getPush', config),
    listTaskPushNotificationConfigs: answer('listPush', { configs: [config], nextPageToken: '' }),
    deleteTaskPushNotificationConfig: answer('deletePush', undefined),
    resubscribe: (params, context) => events('resubscribe', params, context),
    listTasks: answer('listTasks', { tasks: [TASK], nextPageToken: '', pageSize: 1, totalSize: 1 }),
  };
  return { handler, calls, stream };
}

/** The error `work` rejects with, as text; empty when it resolves. */
async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

const message = {
  messageId: 'm1',
  contextId: '',
  taskId: '',
  role: 1,
  parts: [],
  metadata: { note: { deep: true } },
  extensions: [],
  referenceTaskIds: [],
};
const send = { tenant: '', message, configuration: undefined, metadata: undefined };
const byId = { tenant: '', id: 't1' };

describe('InMemoryTransport', () => {
  test('every unary call reaches the handler and answers with a copy', async () => {
    const { handler, calls } = fake();
    const transport = new InMemoryTransport(handler);
    expect([transport.protocolName, transport.protocolVersion]).toEqual([
      IN_MEMORY_PROTOCOL,
      '1.0',
    ]);
    const push = { tenant: '', taskId: 't1', id: 'p1' };
    const results = [
      await transport.getExtendedAgentCard({ tenant: '' }),
      await transport.sendMessage(send),
      await transport.getTask({ ...byId, historyLength: undefined }),
      await transport.cancelTask({ ...byId, metadata: undefined }),
      await transport.createTaskPushNotificationConfig({
        ...push,
        url: '',
        token: '',
        authentication: undefined,
      }),
      await transport.getTaskPushNotificationConfig(push),
      await transport.listTaskPushNotificationConfig({
        tenant: '',
        taskId: 't1',
        pageSize: 0,
        pageToken: '',
      }),
      await transport.listTasks({
        tenant: '',
        contextId: 'c1',
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
        historyLength: 0,
      }),
    ];
    await transport.deleteTaskPushNotificationConfig(push);
    expect(calls.map(([method]) => method)).toEqual([
      'extendedCard',
      'sendMessage',
      'getTask',
      'cancelTask',
      'createPush',
      'getPush',
      'listPush',
      'listTasks',
      'deletePush',
    ]);
    expect(results[1]).toEqual(TASK);
    expect(results[1]).not.toBe(TASK);
    // The handler was given a copy of the message, not the caller's object.
    const received = calls[1]?.[1];
    expect(received).toEqual(send);
    expect(received).not.toBe(send);
  });

  test('service parameters become the call context the HTTP bindings would build', async () => {
    const { handler, calls } = fake();
    const transport = new InMemoryTransport(handler);
    const serviceParameters = ServiceParameters.create(
      withA2AExtensions('https://example.test/ext/a', 'https://example.test/ext/b'),
      (parameters) => {
        parameters['A2A-Version'] = '1.0';
        parameters['Traceparent'] = '00-abc-def-01';
      },
    );
    await transport.getTask({ ...byId, historyLength: undefined }, { serviceParameters });
    await transport.getTask({ ...byId, historyLength: undefined });
    const context = calls[0]?.[2];
    expect([...(context?.requestedExtensions ?? [])]).toEqual([
      'https://example.test/ext/a',
      'https://example.test/ext/b',
    ]);
    expect(context?.requestedVersion).toBe('1.0');
    expect(context?.user?.isAuthenticated).toBe(false);
    expect(context?.state.get(STATE_HEADERS_KEY)).toMatchObject({ traceparent: '00-abc-def-01' });
    expect([...(calls[1]?.[2].requestedExtensions ?? [])]).toEqual([]);
  });

  test('a stream yields copies of the events until the handler is done', async () => {
    const { handler, stream } = fake();
    const transport = new InMemoryTransport(handler);
    const seen: StreamResponse[] = [];
    for await (const event of transport.sendMessageStream(send)) {
      seen.push(event);
      // The handler waits for its second event only after this one was taken.
      setTimeout(() => {
        stream.release();
      }, 5);
    }
    expect(seen).toEqual([taskEvent(), taskEvent()]);
    expect(seen[0]?.payload?.value).not.toBe(TASK);
    expect(stream.returned).toBe(true);
  });

  test('aborting a stream ends it with the reason and releases the handler', async () => {
    const { handler, stream } = fake();
    const transport = new InMemoryTransport(handler);
    const stop = new AbortController();
    const events = transport.resubscribeTask(byId, { signal: stop.signal });
    expect((await events.next()).done).toBe(false);
    const waiting = events.next();
    stop.abort('the surface closed');
    expect(await rejection(waiting)).toBe('the surface closed');
    // The handler's generator ends once the event it was waiting for arrives.
    stream.release();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(stream.returned).toBe(true);
  });

  test('a call with a signal that already aborted never reaches the handler', async () => {
    const { handler, calls } = fake();
    const transport = new InMemoryTransport(handler);
    const stop = new AbortController();
    stop.abort(new Error('too late'));
    const options = { signal: stop.signal };
    const read = transport.getTask({ ...byId, historyLength: undefined }, options);
    expect(await rejection(read)).toBe('too late');
    expect(await rejection(transport.sendMessageStream(send, options).next())).toBe('too late');
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(calls).toEqual([]);
  });

  test('a call never completes within the turn that made it', async () => {
    const transport = new InMemoryTransport(fake().handler);
    let turned = false;
    setTimeout(() => {
      turned = true;
    }, 0);
    await transport.getTask({ ...byId, historyLength: undefined });
    expect(turned).toBe(true);
  });

  test('connectInMemory opens the SDK client on the handler with its card', async () => {
    const client = await connectInMemory(fake().handler);
    expect(client.transport).toBeInstanceOf(InMemoryTransport);
    expect((await client.getAgentCard()).name).toBe('fake');
  });
});
