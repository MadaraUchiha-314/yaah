import type { Message, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import type { TaskView, TranscriptItem } from './view.ts';
import { EMPTY_VIEW, foldEvent } from './view.ts';

function message(messageId: string, role: Role, text: string): Message {
  return {
    messageId,
    contextId: 'c1',
    taskId: 't1',
    role,
    parts: [
      { content: { $case: 'text', value: text }, mediaType: '', filename: '', metadata: undefined },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function snapshot(history: Message[]): StreamResponse {
  const task: Task = {
    id: 't1',
    contextId: 'c1',
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: '' },
    history,
    artifacts: [],
    metadata: undefined,
  };
  return { payload: { $case: 'task', value: task } };
}

const said = (items: readonly TranscriptItem[]): string[] =>
  items.map((item) => `${item.id}:${'text' in item ? item.text : ''}`);

describe('a snapshot of the task', () => {
  test('adds a message whose text repeats one already shown', () => {
    const view: TaskView = foldEvent(
      EMPTY_VIEW,
      snapshot([message('m1', Role.ROLE_USER, 'yes'), message('a1', Role.ROLE_AGENT, 'Done.')]),
    );
    const next = foldEvent(
      view,
      snapshot([
        message('m1', Role.ROLE_USER, 'yes'),
        message('a1', Role.ROLE_AGENT, 'Done.'),
        message('m2', Role.ROLE_USER, 'yes'),
        message('a2', Role.ROLE_AGENT, 'Done.'),
        message('m3', Role.ROLE_USER, 'no'),
      ]),
    );
    expect(said(next.items)).toEqual(['m1:yes', 'a1:Done.', 'm2:yes', 'a2:Done.', 'm3:no']);
  });

  test('stands a streamed answer for its stored message once, by text', () => {
    const streamed: TaskView = {
      ...EMPTY_VIEW,
      taskId: 't1',
      items: [
        { kind: 'user', id: 'm1', text: 'hi' },
        { kind: 'agent', id: 'response-k1', text: 'Hello.', streaming: false, a2ui: [] },
      ],
    };
    const next = foldEvent(
      streamed,
      snapshot([
        message('m1', Role.ROLE_USER, 'hi'),
        message('a1', Role.ROLE_AGENT, 'Hello.'),
        message('m2', Role.ROLE_USER, 'hi'),
        message('a2', Role.ROLE_AGENT, 'Hello.'),
      ]),
    );
    expect(said(next.items)).toEqual(['m1:hi', 'response-k1:Hello.', 'm2:hi', 'a2:Hello.']);
  });
});
