import { afterEach, describe, expect, test } from 'bun:test';
import { TaskState } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';

import { EXT } from '../../src/app/api-server/extensions/index.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

async function start(options: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  running = await startHarness(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const lifecycle = (data: Record<string, unknown>) => ({ [EXT.taskLifecycle]: data });

async function exercise(client: Client, harness: TestHarness): Promise<string[]> {
  const done: string[] = [];
  const request = (text: string, metadata?: Record<string, unknown>) => ({
    tenant: '',
    message: harness.message(text, { metadata: metadata ?? {} }),
    configuration: undefined,
    metadata: undefined,
  });

  const sent = await client.sendMessage(request('one', lifecycle({ longRunning: true })));
  const taskId = 'id' in sent ? sent.id : '';
  expect('status' in sent ? sent.status?.state : undefined).toBe(
    TaskState.TASK_STATE_INPUT_REQUIRED,
  );
  done.push('SendMessage');

  let streamed = 0;
  for await (const event of client.sendMessageStream(request('two'))) {
    streamed += event.payload === undefined ? 0 : 1;
  }
  expect(streamed).toBeGreaterThan(1);
  done.push('SendStreamingMessage');

  expect((await client.getTask({ tenant: '', id: taskId })).id).toBe(taskId);
  done.push('GetTask');

  const listed = await client.listTasks({
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
  });
  expect(listed.tasks.map((task) => task.id)).toContain(taskId);
  done.push('ListTasks');

  const config = {
    tenant: '',
    taskId,
    id: 'hook-1',
    url: 'http://127.0.0.1:9/hook',
    token: '',
    authentication: undefined,
  };
  const created = await client.createTaskPushNotificationConfig(config);
  expect(created.id).toBe('hook-1');
  done.push('CreateTaskPushNotificationConfig');
  expect(
    (await client.getTaskPushNotificationConfig({ tenant: '', taskId, id: 'hook-1' })).url,
  ).toBe(config.url);
  done.push('GetTaskPushNotificationConfig');
  const hooks = await client.listTaskPushNotificationConfig({
    tenant: '',
    taskId,
    pageSize: 10,
    pageToken: '',
  });
  expect(hooks.configs.length).toBe(1);
  done.push('ListTaskPushNotificationConfigs');
  await client.deleteTaskPushNotificationConfig({ tenant: '', taskId, id: 'hook-1' });
  done.push('DeleteTaskPushNotificationConfig');

  const controller = new AbortController();
  const subscription = client.resubscribeTask(
    { tenant: '', id: taskId },
    { signal: controller.signal },
  );
  const first = await subscription.next();
  expect(first.value?.payload?.$case).toBe('task');
  controller.abort();
  await subscription.return().catch(() => undefined);
  done.push('SubscribeToTask');

  const canceled = await client.cancelTask({ tenant: '', id: taskId, metadata: undefined });
  expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  done.push('CancelTask');
  return done;
}

const ALL = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'SubscribeToTask',
  'CancelTask',
];

describe('A2A API server', () => {
  /**
   * Feature: A2A API server
   * Scenario: Every A2A operation answers over JSON-RPC and HTTP+JSON
   *   Given a harness and the official SDK client bound to one protocol binding
   *   When each operation of the specification is called
   *   Then each answers as specified
   * Requirement: docs/specs/issue-3/requirements.md R13.1
   */
  for (const [binding, factory] of [
    ['JSON-RPC', new JsonRpcTransportFactory()],
    ['HTTP+JSON', new RestTransportFactory()],
  ] as const) {
    test(`Every A2A operation answers over ${binding}`, async () => {
      const harness = await start({ turns: [say('first'), say('second')] });
      const client = await new ClientFactory({ transports: [factory] }).createFromUrl(harness.url);
      expect(await exercise(client, harness)).toEqual(ALL);
    });
  }

  /**
   * Feature: A2A API server
   * Scenario: The agent card lists every yaah extension
   *   Given a running harness
   *   When the agent card is fetched from its well-known path
   *   Then it names both bindings, declares streaming, lists each yaah extension as optional
   *   And declares no security scheme
   * Requirement: docs/specs/issue-3/requirements.md R13.2, R13.3
   */
  test('The agent card lists every yaah extension', async () => {
    const harness = await start({});
    const card = await harness.client.getAgentCard();
    const uris = card.capabilities?.extensions.map((extension) => extension.uri) ?? [];
    for (const uri of Object.values(EXT)) {
      expect(uris).toContain(uri);
    }
    expect(card.capabilities?.extensions.every((extension) => !extension.required)).toBe(true);
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.supportedInterfaces.map((entry) => entry.protocolBinding)).toEqual([
      'JSONRPC',
      'HTTP+JSON',
    ]);
    expect(card.supportedInterfaces.every((entry) => entry.url.startsWith(harness.url))).toBe(true);
    expect(card.securitySchemes).toEqual({});
    const durable = card.capabilities?.extensions.find(
      (extension) => extension.uri === EXT.durableExecution,
    );
    expect(durable?.params).toEqual({ mode: 'none', dashboardUrl: null });
  });

  /**
   * Feature: A2A API server
   * Scenario: A required unsupported extension is rejected
   *   Given a harness whose card marks an extension as required
   *   When a client sends a message without declaring that extension
   *   Then the request is rejected with the specification's error and no task is created
   * Requirement: docs/specs/issue-3/requirements.md R13.4
   */
  test('A required unsupported extension is rejected', async () => {
    const required = 'https://example.test/ext/must-have/v1';
    const harness = await start({
      turns: [say('never')],
      setup: (ctx) => {
        ctx.a2a.addExtension({
          uri: required,
          description: 'x',
          required: true,
          params: undefined,
        });
      },
    });
    // The card is fixed when the listener starts; ask the service for a fresh handler.
    const handler = harness.harness.ctx.a2a.handlerFor(harness.url);
    let message = '';
    try {
      const { ServerCallContext } = await import('@a2a-js/sdk/server');
      await handler.sendMessage(
        {
          tenant: '',
          message: harness.message('hi'),
          configuration: undefined,
          metadata: undefined,
        },
        new ServerCallContext(),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(required);
    expect(harness.llm.requests.length).toBe(0);
  });

  /**
   * Feature: A2A API server
   * Scenario: A malformed request creates no task
   *   Given a running harness
   *   When a JSON-RPC request with no message is posted
   *   Then an error is returned and no task exists
   * Requirement: docs/specs/issue-3/requirements.md R13.5
   */
  test('A malformed request creates no task', async () => {
    const harness = await start({ turns: [say('never')] });
    const response = await fetch(`${harness.url}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    });
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain('error');
    const listed = await harness.client.listTasks({
      tenant: '',
      contextId: '',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
    });
    expect(listed.totalSize).toBe(0);
    expect(harness.llm.requests.length).toBe(0);
  });
});
