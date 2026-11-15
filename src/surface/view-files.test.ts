import type { Artifact, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import { PNG_1X1, rawPart, urlPart } from '../../test/support/media.ts';
import { EXT } from '../app/api-server/extensions/index.ts';
import { dataUrl, fromBase64, toBase64 } from './bytes.ts';
import type { FileItem } from './view-files.ts';
import {
  fileItems,
  fileLabel,
  fileLink,
  fileLocation,
  isSpeech,
  speechChunk,
} from './view-files.ts';
import { EMPTY_VIEW, foldEvent, viewOfTask, withUserMessage } from './view.ts';

const text = (value: string): Part => ({
  content: { $case: 'text', value },
  mediaType: '',
  filename: '',
  metadata: undefined,
});

function artifact(change: Partial<Artifact>): Artifact {
  return {
    artifactId: 'a1',
    name: 'attachment',
    description: '',
    parts: [],
    metadata: undefined,
    extensions: [],
    ...change,
  };
}

function update(value: Artifact, append = false, lastChunk = true): StreamResponse {
  return {
    payload: {
      $case: 'artifactUpdate',
      value: {
        taskId: 't1',
        contextId: 'c1',
        artifact: value,
        append,
        lastChunk,
        metadata: undefined,
      },
    },
  };
}

function speech(metadata: unknown, parts: Part[] = [rawPart('audio/pcm', 'AAABAA==')]): Artifact {
  return artifact({
    artifactId: 'speech-k1',
    name: 'speech',
    parts,
    extensions: [EXT.voice],
    metadata: { [EXT.voice]: metadata },
  });
}

const FORMAT = { sampleRate: 24_000, channels: 1, encoding: 's16le' };
const item = (change: Partial<FileItem>): FileItem => ({
  kind: 'file',
  id: 'a1/0',
  from: 'agent',
  mediaType: 'image/png',
  name: 'lamp.png',
  url: null,
  ...change,
});

describe('bytes', () => {
  test('go to base64 and back unchanged, whatever their length', () => {
    for (const length of [0, 1, 2, 3, 100_000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 7) % 256);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    }
    expect(dataUrl('image/png', Uint8Array.from([104, 105]))).toBe('data:image/png;base64,aGk=');
  });
});

describe('files of a view', () => {
  test('an inline image becomes a data URL; other inline content keeps no bytes', () => {
    const parts = [
      text('look'),
      rawPart('image/png', PNG_1X1, 'pixel.png'),
      rawPart('audio/webm', 'AAAA', 'voice-message.webm'),
      urlPart('image/jpeg', 'https://img.example/a.jpg'),
      rawPart('image/png" onload="x', PNG_1X1),
    ];
    expect(fileItems(parts, 'm1', 'user')).toEqual([
      item({
        id: 'm1/1',
        from: 'user',
        name: 'pixel.png',
        url: `data:image/png;base64,${PNG_1X1}`,
      }),
      item({ id: 'm1/2', from: 'user', mediaType: 'audio/webm', name: 'voice-message.webm' }),
      item({
        id: 'm1/3',
        from: 'user',
        mediaType: 'image/jpeg',
        name: '',
        url: 'https://img.example/a.jpg',
      }),
      item({ id: 'm1/4', from: 'user', mediaType: 'image/png" onload="x', name: '' }),
    ]);
  });

  test('a file is labelled by what it is and who sent it', () => {
    expect(fileLabel(item({}))).toBe('Image');
    expect(fileLabel(item({ mediaType: 'audio/webm', from: 'user' }))).toBe('Voice message');
    expect(fileLabel(item({ mediaType: 'audio/wav' }))).toBe('Audio');
    expect(fileLabel(item({ mediaType: 'application/pdf' }))).toBe('File');
  });

  test('only an absolute https address counts as a link; anything else is "with the task"', () => {
    expect(fileLink(item({ url: 'https://img.example/a.png' }))).toBe('https://img.example/a.png');
    for (const url of ['http://img.example/a.png', 'javascript:alert(1)', 'not a url', null]) {
      expect(fileLink(item({ url }))).toBeNull();
      expect(fileLocation(item({ url }))).toBe('kept with the task as a1/0');
    }
    expect(fileLocation(item({ url: 'https://img.example/a.png' }))).toBe(
      'at https://img.example/a.png',
    );
  });

  test('what the user sends shows at once: the text when there is any, and the files', () => {
    const file = item({ id: 'm1/0', from: 'user' });
    const both = withUserMessage(EMPTY_VIEW, 'm1', 'Look at this', [file]);
    expect(both.state).toBe('working');
    expect(both.items).toEqual([{ kind: 'user', id: 'm1', text: 'Look at this' }, file]);
    expect(withUserMessage(EMPTY_VIEW, 'm1', '', [file]).items).toEqual([file]);
  });

  test('an artifact of files adds them to the transcript, once', () => {
    const image = artifact({ parts: [rawPart('image/png', PNG_1X1, 'lamp.png')] });
    const once = foldEvent(EMPTY_VIEW, update(image));
    const twice = foldEvent(once, update(image));
    expect(twice.items).toEqual([item({ url: `data:image/png;base64,${PNG_1X1}` })]);
  });

  test('a stored task shows the files users sent in place and what the agent attached after', () => {
    const task: Task = {
      id: 't1',
      contextId: 'c1',
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: '' },
      history: [
        {
          messageId: 'm1',
          contextId: 'c1',
          taskId: 't1',
          role: Role.ROLE_USER,
          parts: [rawPart('audio/wav', 'AAAA')],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
      ],
      artifacts: [
        artifact({ artifactId: 'response-k1', name: 'response', parts: [text('Here.')] }),
        artifact({ artifactId: 'artifact-k2', parts: [rawPart('image/png', PNG_1X1, 'lamp.png')] }),
      ],
      metadata: undefined,
    };
    expect(viewOfTask(task).items).toEqual([
      item({ id: 'm1/0', from: 'user', mediaType: 'audio/wav', name: '' }),
      item({ id: 'artifact-k2/0', url: `data:image/png;base64,${PNG_1X1}` }),
    ]);
    // A surface that already shows the image does not show it twice when it re-reads the task.
    const shown = foldEvent(EMPTY_VIEW, { payload: { $case: 'task', value: task } });
    const reread = foldEvent(shown, { payload: { $case: 'task', value: task } });
    expect(reread.items.length).toBe(2);
  });
});

describe('speech', () => {
  test('a speech artifact is not shown: it leaves the view as it was', () => {
    const view = withUserMessage(EMPTY_VIEW, 'm1', 'Hello');
    expect(foldEvent(view, update(speech(FORMAT), true, false))).toBe(view);
    expect(isSpeech(speech(FORMAT))).toBe(true);
    expect(isSpeech(artifact({}))).toBe(false);
    expect(isSpeech(undefined)).toBe(false);
  });

  test('its audio is read with the format it declares', () => {
    const chunk = speechChunk(speech(FORMAT), true);
    expect(chunk).toMatchObject({
      artifactId: 'speech-k1',
      sampleRate: 24_000,
      channels: 1,
      last: true,
    });
    expect([...(chunk?.data ?? [])]).toEqual([0, 0, 1, 0]);
  });

  test('nothing is played from an artifact that is not speech or does not say how to play it', () => {
    expect(speechChunk(undefined, false)).toBeNull();
    expect(speechChunk(artifact({ parts: [rawPart('audio/pcm', 'AAAA')] }), false)).toBeNull();
    expect(speechChunk(speech({ sampleRate: 'fast' }), false)).toBeNull();
    expect(speechChunk(speech(FORMAT, [text('not audio')]), false)).toBeNull();
    expect(speechChunk(speech(FORMAT, []), false)).toBeNull();
  });
});
