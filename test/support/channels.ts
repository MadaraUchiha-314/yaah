/**
 * Channels without a network: a channel manager over the in-memory task port, and agents
 * that answer from a function — enough to test membership, routing and the two tools.
 */
import type { Message, StreamResponse } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import type { Agent } from '../../src/harness/a2a/types.ts';
import { ChannelManager } from '../../src/harness/channels/manager.ts';
import type { Participant, ToolResult } from '../../src/harness/core/types.ts';
import type { ToolCallContext } from '../../src/harness/tools/types.ts';
import { createMemoryPersistence } from '../../src/harness/core/memory-persistence.ts';
import { EntityRegistry } from '../../src/kernel/registry.ts';
import { MemoryTaskPort } from '../../src/testing/memory-task-port.ts';

/** The participants most tests start from: one user who reported, the harness, one agent. */
export const PARTICIPANTS: readonly Participant[] = [
  { id: 'ada', role: 'reporter', kind: 'user', displayName: 'Ada' },
  { id: 'self', role: 'assignee', kind: 'agent' },
  { id: 'billing', role: 'watcher', kind: 'agent' },
];

/** What a fake agent received. */
export interface FakeAgent {
  readonly agent: Agent;
  /** Every message sent to it, in order. */
  readonly received: Message[];
}

function text(value: string): Message['parts'] {
  return [{ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: '' }];
}

function notUsed(): Promise<never> {
  return Promise.reject(new Error('the fake agent only answers messages'));
}

/**
 * An agent that opens a task `<id>-task` and ends it in `state` with the status text
 * `answer(request)`.
 */
export function fakeAgent(
  id: string,
  answer: (request: Message) => string,
  state: TaskState = TaskState.TASK_STATE_COMPLETED,
): FakeAgent {
  const received: Message[] = [];
  const taskId = `${id}-task`;
  const contextId = `${id}-context`;
  const agent: Agent = {
    ref: { kind: 'agent', id, version: null },
    name: id,
    description: `The ${id} agent.`,
    locality: { type: 'local' },
    skills: [],
    // oxlint-disable-next-line typescript/require-await -- a stream that is ready at once
    async *sendMessage(request: Message): AsyncIterable<StreamResponse> {
      received.push(request);
      const message: Message = {
        messageId: `${taskId}-status`,
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: text(answer(request)),
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
      const status = { state, message, timestamp: '2026-01-01T00:00:00.000Z' };
      yield {
        payload: {
          $case: 'task',
          value: {
            id: taskId,
            contextId,
            status: { ...status, state: TaskState.TASK_STATE_WORKING, message: undefined },
            history: [],
            artifacts: [],
            metadata: undefined,
          },
        },
      };
      yield {
        payload: {
          $case: 'statusUpdate',
          value: { taskId, contextId, status, metadata: undefined },
        },
      };
    },
    cancelTask: notUsed,
    getCard: notUsed,
  };
  return { agent, received };
}

/** A channel manager and what it stands on. */
export interface ChannelFixture {
  readonly taskId: string;
  readonly registry: EntityRegistry;
  readonly tasks: MemoryTaskPort;
  readonly channels: ChannelManager;
  /** The context of a tool call numbered `n` on the fixture's task. */
  readonly call: (n: number) => ToolCallContext;
}

/** Builds a manager over one task, `t1`, with the given participants and depth. */
export function channelFixture(
  participants: readonly Participant[] = PARTICIPANTS,
  options: { readonly depth?: number; readonly maxDepth?: number } = {},
): ChannelFixture {
  const registry = new EntityRegistry();
  const tasks = new MemoryTaskPort();
  tasks.create({ taskId: 't1', model: { participants, depth: options.depth ?? 0 } });
  return {
    taskId: 't1',
    registry,
    tasks,
    channels: new ChannelManager({
      registry,
      tasks,
      state: createMemoryPersistence().state,
      maxDepth: options.maxDepth ?? 3,
    }),
    call: (n: number): ToolCallContext => ({
      taskId: 't1',
      callId: `c${String(n)}`,
      key: `t1/${String(n)}/tool.invoke/c${String(n)}`,
      signal: new AbortController().signal,
    }),
  };
}

/** A tool result as one line: its text, or `error <code>: <message>`. */
export function resultText(result: ToolResult): string {
  return result.ok
    ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : `error ${result.error.code}: ${result.error.message}`;
}

/** The text of a message's parts. */
export function sentText(message: Message | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}
