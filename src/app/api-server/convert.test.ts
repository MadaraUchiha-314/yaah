import { describe, expect, test } from 'bun:test';
import { Role, TaskState } from '@a2a-js/sdk';

import type { ContentPart } from '../../harness/core/types.ts';
import {
  agentMessage,
  fromA2aState,
  messageText,
  metadataObject,
  partsFromA2a,
  partsToA2a,
  resultArtifact,
  toA2aState,
  toA2aStatus,
} from './convert.ts';
import { EXT } from './extensions/index.ts';

const parts: ContentPart[] = [
  { type: 'text', text: 'hello' },
  { type: 'file', mediaType: 'image/png', source: { kind: 'base64', data: 'aGk=' }, name: 'a.png' },
  {
    type: 'file',
    mediaType: 'audio/wav',
    source: { kind: 'url', url: 'https://x/a.wav' },
    name: undefined,
  },
  { type: 'data', mediaType: 'application/a2ui+json', data: [{ a: 1 }] },
];

describe('parts', () => {
  test('survive a round trip through A2A', () => {
    expect(partsFromA2a(partsToA2a(parts))).toEqual(parts);
  });

  test('a data part without a media type is JSON', () => {
    const [converted] = partsFromA2a([
      {
        content: { $case: 'data', value: { a: 1 } },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ]);
    expect(converted).toEqual({ type: 'data', mediaType: 'application/json', data: { a: 1 } });
  });

  test('a part with no content is dropped', () => {
    expect(
      partsFromA2a([{ content: undefined, metadata: undefined, filename: '', mediaType: '' }]),
    ).toEqual([]);
  });
});

describe('states', () => {
  test('map both ways', () => {
    for (const state of ['working', 'input-required', 'completed', 'canceled', 'failed'] as const) {
      expect(fromA2aState(toA2aState(state))).toBe(state);
    }
  });

  test('a state the core never produces reads as working', () => {
    expect(fromA2aState(TaskState.TASK_STATE_SUBMITTED)).toBe('working');
    expect(fromA2aState()).toBe('working');
  });
});

describe('toA2aStatus', () => {
  const base = {
    taskId: 't1',
    contextId: 'c1',
    messageId: 'k1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  test('puts the sub-state in the status message metadata under the extension URI', () => {
    const status = toA2aStatus({
      ...base,
      state: 'input-required',
      subState: 'awaiting-user-input',
      message: [{ type: 'text', text: 'Which one?' }],
    });
    expect(status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(status.message?.role).toBe(Role.ROLE_AGENT);
    expect(status.message?.messageId).toBe('k1');
    expect(status.message?.extensions).toEqual([EXT.taskLifecycle]);
    expect(metadataObject(status.message?.metadata)[EXT.taskLifecycle]).toEqual({
      subState: 'awaiting-user-input',
      schemaVersion: 1,
    });
    expect(messageText(status.message)).toBe('Which one?');
  });

  test('a status with nothing to say has no message', () => {
    expect(
      toA2aStatus({ ...base, state: 'canceled', subState: null, message: [] }).message,
    ).toBeUndefined();
  });

  test('a sub-state alone still produces a message to carry it', () => {
    const status = toA2aStatus({
      ...base,
      state: 'input-required',
      subState: 'awaiting-next-interaction',
      message: [],
    });
    expect(status.message?.parts).toEqual([]);
    expect(status.message?.extensions).toEqual([EXT.taskLifecycle]);
  });
});

describe('helpers', () => {
  test('agentMessage copies metadata and extensions', () => {
    const message = agentMessage({
      messageId: 'm',
      taskId: 't',
      contextId: 'c',
      parts: [{ type: 'text', text: 'x' }],
      metadata: { a: 1 },
      extensions: ['uri'],
    });
    expect(message.metadata).toEqual({ a: 1 });
    expect(message.extensions).toEqual(['uri']);
  });

  test('resultArtifact wraps parts', () => {
    expect(resultArtifact('a1', [{ type: 'text', text: 'done' }]).parts.length).toBe(1);
  });

  test('metadataObject drops what is not a JSON object', () => {
    expect(metadataObject(null)).toEqual({});
    expect(metadataObject('x')).toEqual({});
    expect(metadataObject({ a: [1] })).toEqual({ a: [1] });
  });
});
