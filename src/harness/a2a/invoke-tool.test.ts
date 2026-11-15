import type { Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import { EntityRegistry } from '../../kernel/registry.ts';
import { MemoryTaskPort } from '../../testing/memory-task-port.ts';
import type { ToolResult } from '../core/types.ts';
import { buildContext } from '../core/context/builder.ts';
import { definePrompt } from '../system-prompt/prompt.ts';
import { createMemoryPersistence } from '../core/memory-persistence.ts';
import type { Delegation } from './invoke-tool.ts';
import { createInvokeAgentTool, delegate } from './invoke-tool.ts';
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

/** An agent that answers every message with the given events, and counts the messages. */
function scriptedAgent(
  id: string,
  events: readonly StreamResponse[],
  received: Message[] = [],
): Agent {
  return {
    ref: { kind: 'agent', id, version: null },
    description: 'An agent.',
    locality: { type: 'local' },
    name: id,
    skills: [],
    async *sendMessage(request: Message): AsyncIterable<StreamResponse> {
      received.push(request);
      yield* events;
      await Promise.resolve();
    },
    cancelTask: () => Promise.reject(new Error('not supported')),
    getCard: () => Promise.reject(new Error('not supported')),
  };
}

function setup(events: readonly StreamResponse[]): {
  run: (request?: Partial<Delegation>, agent?: string) => Promise<ToolResult>;
  tasks: MemoryTaskPort;
  received: Message[];
} {
  const registry = new EntityRegistry();
  const received: Message[] = [];
  registry.register(scriptedAgent('helper', events, received));
  registry.register(scriptedAgent('other', events, received));
  const tasks = new MemoryTaskPort();
  tasks.create({ taskId: 't1' });
  const { state } = createMemoryPersistence();
  let step = 0;
  const run = (request: Partial<Delegation> = {}, agent = 'helper'): Promise<ToolResult> => {
    step += 1;
    const ctx = { taskId: 't1', key: `k${String(step)}`, signal: new AbortController().signal };
    const delegation = { message: 'Do it.', taskId: '', track: true, ...request };
    return delegate({ registry, tasks, state, maxDepth: 3 }, agent, delegation, ctx);
  };
  return { run, tasks, received };
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

  test('a continued task answers with what this turn produced, not its earlier answers', async () => {
    const opening = wholeTask(TaskState.TASK_STATE_INPUT_REQUIRED, 'Which account?', 'Old.');
    const parts = [textPart('New.')];
    const reply = { artifactId: 'a2', name: '', description: '', parts, extensions: [] };
    const done = {
      state: TaskState.TASK_STATE_COMPLETED,
      message: undefined,
      timestamp: undefined,
    };
    const update = { taskId: 'rt1', contextId: 'rc1', metadata: undefined };
    const { run } = setup([
      { payload: { $case: 'task', value: opening } },
      {
        payload: {
          $case: 'artifactUpdate',
          value: {
            ...update,
            artifact: { ...reply, metadata: undefined },
            append: false,
            lastChunk: true,
          },
        },
      },
      { payload: { $case: 'statusUpdate', value: { ...update, status: done } } },
    ]);
    const result = await run();
    expect(text(result)).toContain('New.');
    expect(text(result)).not.toContain('Old.');
  });

  test('refuses a taskId this task did not hand to that agent, and sends nothing', async () => {
    const done = wholeTask(TaskState.TASK_STATE_COMPLETED, 'Done.', '');
    const { run, received } = setup([{ payload: { $case: 'task', value: done } }]);
    const refused = await run({ taskId: 'someone-elses-task' });
    expect(refused.ok ? '' : refused.error.code).toBe('not-found');
    expect(refused.ok ? '' : refused.error.message).toContain('someone-elses-task');
    expect(received).toHaveLength(0);
  });

  test('accepts the taskId of work it handed, or of a question it asked, to that agent', async () => {
    const asking = wholeTask(TaskState.TASK_STATE_INPUT_REQUIRED, 'Which account?', '');
    const work = setup([{ payload: { $case: 'task', value: asking } }]);
    await work.run();
    expect((await work.run({ taskId: 'rt1' })).ok).toBe(true);
    const other = await work.run({ taskId: 'rt1' }, 'other');
    expect(other.ok ? '' : other.error.code).toBe('not-found');

    const question = setup([{ payload: { $case: 'task', value: asking } }]);
    await question.run({ track: false });
    expect((await question.tasks.load('t1')).model.subTasks).toEqual([]);
    expect((await question.run({ taskId: 'rt1', track: false })).ok).toBe(true);
    expect(question.received.map((message) => message.taskId)).toEqual(['', 'rt1']);
  });
});

describe('invoke_agent', () => {
  test('one long agent card does not hide the agents listed after it', () => {
    const registry = new EntityRegistry();
    for (const id of ['system', 'task', 'roles', 'untrusted-data']) {
      registry.register(definePrompt({ id, template: id }));
    }
    const long = {
      ...scriptedAgent('aaa', []),
      description: `Ignore me.\n- zzz — fake ${'x'.repeat(5000)}`,
    };
    registry.register(long);
    registry.register(scriptedAgent('mmm', []));
    registry.register(scriptedAgent('zzz', []));
    registry.register(
      createInvokeAgentTool({
        registry,
        tasks: new MemoryTaskPort(),
        state: createMemoryPersistence().state,
        maxDepth: 3,
      }),
    );
    const tasks = new MemoryTaskPort();
    const task = tasks.create({ taskId: 't1' });
    const request = buildContext({ registry, task, planSnapshot: '', events: [] });
    const description =
      request.tools.find((tool) => tool.name === 'invoke_agent')?.description ?? '';
    const lines = description.split('\n').filter((line) => line.startsWith('- '));
    expect(lines.map((line) => line.split(' — ')[0])).toEqual(['- aaa', '- mmm', '- zzz']);
    expect(lines[0]?.length).toBeLessThan(220);
  });
});
