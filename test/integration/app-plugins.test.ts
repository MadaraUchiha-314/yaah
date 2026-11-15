import { afterEach, describe, expect, test } from 'bun:test';

import { PluginLoadError } from '../../src/kernel/errors.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('app plugins', () => {
  /**
   * Feature: Durable execution
   * Scenario: An unavailable durable mode stops start-up
   *   Given a configuration that selects a durable mode this build cannot provide
   *   When the harness starts
   *   Then start-up fails naming the durable plugin, and nothing is left listening
   * Requirement: docs/specs/issue-3/requirements.md R17.7, R1.4
   */
  test('An unavailable durable mode stops start-up', async () => {
    let caught: unknown = null;
    try {
      running = await startHarness({ config: '[durable]\nmode = "temporal-remote"' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect(caught instanceof PluginLoadError ? caught.entryId : '').toBe('durable');
  });

  /**
   * Feature: A2A API server
   * Scenario: A plugin adds to the agent card and can take it back
   *   Given a running harness
   *   When a plugin adds an extension and a command list, then removes them
   *   Then the card shows them while they are registered and not afterwards
   * Requirement: docs/specs/issue-3/requirements.md R13.3, R1.5
   */
  test('A plugin adds to the agent card and can take it back', async () => {
    running = await startHarness({});
    const { a2a } = running.harness.ctx;
    const uri = 'https://example.test/ext/v1';
    const removeExtension = a2a.addExtension({
      uri,
      description: 'x',
      required: false,
      params: undefined,
    });
    const removeCommands = a2a.setCommands(
      () => Promise.resolve(null),
      () => [{ name: 'model', description: 'Select the model', scope: 'harness' }],
    );
    const uris = () =>
      a2a.cardFor('http://x').capabilities?.extensions.map((extension) => extension.uri) ?? [];
    const commands = () =>
      JSON.stringify(
        a2a.cardFor('http://x').capabilities?.extensions.find((e) => e.uri.endsWith('/commands/v1'))
          ?.params,
      );
    expect(uris()).toContain(uri);
    expect(commands()).toContain('"model"');
    removeExtension();
    removeCommands();
    expect(uris()).not.toContain(uri);
    expect(commands()).toBe('{"commands":[]}');
  });

  /**
   * Feature: Context window manager and compaction
   * Scenario: Compaction is reported as an event
   *   Given a long-running task whose model has a very small context window
   *   When a second turn pushes the conversation over the threshold
   *   Then a context/compacted event reports fewer tokens after than before
   * Requirement: docs/specs/issue-3/requirements.md R6.5
   */
  test('Compaction is reported as an event', async () => {
    const reported: [number, number][] = [];
    const filler = 'word '.repeat(200);
    running = await startHarness({
      turns: [say(`one ${filler}`), say(`two ${filler}`), say('summary'), say('three')],
      setup: (ctx) => {
        ctx.on('context/compacted', (_taskId, before, after) => {
          reported.push([before, after]);
        });
      },
    });
    const keepOpen = {
      'https://github.com/MadaraUchiha-314/yaah/extensions/task-lifecycle/v1': {
        longRunning: true,
      },
    };
    const first = await running.send(`q1 ${filler}`, { metadata: keepOpen });
    const taskId = first.task?.id ?? '';
    await running.send(`q2 ${filler}`, { taskId });
    Object.assign(running.llm.capabilities, { contextWindow: 1200 });
    await running.send('q3', { taskId });
    expect(reported.length).toBe(1);
    expect((reported[0]?.[1] ?? 0) < (reported[0]?.[0] ?? 0)).toBe(true);
  });

  /**
   * Feature: Observability
   * Scenario: A run that ends with an unrecordable error is reported as an event
   *   Given a harness whose status step fails
   *   When a task is started
   *   Then a durable/run-error event names the task
   * Requirement: docs/specs/issue-3/requirements.md R18.1
   */
  test('A run that ends with an unrecordable error is reported as an event', async () => {
    const reported: string[] = [];
    running = await startHarness({
      turns: [say('never')],
      setup: (ctx) => {
        Object.assign(ctx.taskRuntime.handlers, {
          'task.transition': () => Promise.reject(new Error('task store is gone')),
        });
        ctx.on('durable/run-error', (taskId) => {
          reported.push(taskId);
        });
      },
    });
    const response = await running.client.sendMessage({
      tenant: '',
      message: running.message('hi'),
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
    const taskId = 'id' in response ? response.id : '';
    const deadline = Date.now() + 2000;
    while (reported.length === 0 && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the event
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    expect(reported).toEqual([taskId]);
  });
});

describe('shipped composition', () => {
  /**
   * Feature: Tools and MCP
   * Scenario: MCP tools from the configuration are usable with no code
   *   Given a configuration that names an MCP server and nothing else
   *   When the server composition starts and the model calls one of the server's tools
   *   Then the tool was registered by the shipped composition and its result reached the model
   * Requirement: docs/specs/issue-3/requirements.md R1.1, R8.1
   */
  test('MCP tools from the configuration are usable with no code', async () => {
    const stub = new URL('../fixtures/mcp/stub-server.ts', import.meta.url).pathname;
    running = await startHarness({
      config: [
        '[[mcp.servers]]',
        'id = "orders"',
        'transport = "stdio"',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(stub)}]`,
      ].join('\n'),
      turns: [
        callTools(call('c1', 'mcp__orders__lookup_order', { id: 'A-1041' })),
        say('Found it.'),
      ],
    });
    const registered = running.harness.ctx.entities.list('tool').map((tool) => tool.ref.id);
    expect(registered).toContain('mcp__orders__lookup_order');
    expect(registered).toContain('ask_user');
    expect(registered).toContain('invoke_agent');
    await running.send('Look up A-1041');
    const shown = JSON.stringify(running.llm.requests[1]?.messages);
    expect(shown).toContain('A-1041');
    expect(shown).toContain('tool-result');
  });
});
