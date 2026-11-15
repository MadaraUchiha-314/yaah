import type { Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import { EntityRegistry } from '../../kernel/registry.ts';
import { MemoryTaskPort } from '../../testing/memory-task-port.ts';
import type { ToolResult } from '../core/types.ts';
import { delegate } from './invoke-tool.ts';
import type { Agent } from './types.ts';

function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: '',
  };
}

function agentMessage(text: string): Message {
  return {
    messageId: 'm1',
    contextId: 'rc1',
    taskId: 'rt1',
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function wholeTask(state: TaskState, status: string, artifact: string): Task {
  return {
    id: 'rt1',
    contextId: 'rc1',
    status: { state, message: agentMessage(status), timestamp: undefined },
    artifacts:
      artifact === ''
        ? []
        : [
            {
              artifactId: 'a1',
              name: '',
              description: '',
              parts: [textPart(artifact)],
              metadata: undefined,
              extensions: [],
            },
          ],
    history: [],
    metadata: undefined,
  };
}

/** An agent that answers every message with the given events. */
function scriptedAgent(id: string, events: readonly StreamResponse[]): Agent {
  return {
    ref: { kind: 'agent', id, version: null },
    description: 'An agent.',
    locality: { type: 'local' },
    name: id,
    skills: [],
    async *sendMessage(): AsyncIterable<StreamResponse> {
      yield* events;
      await Promise.resolve();
    },
    cancelTask: () => Promise.reject(new Error('not supported')),
    getCard: () => Promise.reject(new Error('not supported')),
  };
}

function setup(events: readonly StreamResponse[]): {
  run: () => Promise<ToolResult>;
  tasks: MemoryTaskPort;
} {
  const registry = new EntityRegistry();
  registry.register(scriptedAgent('helper', events));
  const tasks = new MemoryTaskPort();
  tasks.create({ taskId: 't1' });
  const ctx = { taskId: 't1', key: 'k1', signal: new AbortController().signal };
  const run = (): Promise<ToolResult> =>
    delegate(
      { registry, tasks, maxDepth: 3 },
      'helper',
      { message: 'Do it.', taskId: '', track: true },
      ctx,
    );
  return { run, tasks };
}

const text = (result: ToolResult): string => (result.ok ? JSON.stringify(result.content) : '');

describe('delegate', () => {
  test('reads the answer of an agent that replies with one whole task', async () => {
    const done = wholeTask(TaskState.TASK_STATE_COMPLETED, 'Done.', 'The answer is 42.');
    const { run, tasks } = setup([{ payload: { $case: 'task', value: done } }]);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(text(result)).toContain('The answer is 42.');
    expect((await tasks.load('t1')).model.subTasks).toEqual([
      { taskId: 'rt1', contextId: 'rc1', agent: 'helper' },
    ]);
  });

  test('reads the status message of a whole task when it has no artifact', async () => {
    const done = wholeTask(TaskState.TASK_STATE_COMPLETED, 'All done.', '');
    const { run } = setup([{ payload: { $case: 'task', value: done } }]);
    expect(text(await run())).toContain('All done.');
  });

  test('passes on the question of a whole task that needs input', async () => {
    const asking = wholeTask(TaskState.TASK_STATE_INPUT_REQUIRED, 'Which account?', '');
    const { run } = setup([{ payload: { $case: 'task', value: asking } }]);
    const result = await run();
    expect(text(result)).toContain('Which account?');
    expect(text(result)).toContain('rt1');
  });
});
