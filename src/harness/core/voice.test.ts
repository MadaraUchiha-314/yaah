import { describe, expect, test } from 'bun:test';

import { createCore } from '../../../test/support/core.ts';
import { say } from '../../testing/scripted-llm.ts';
import { ScriptedTextToSpeech, silencePerWord } from '../../testing/scripted-speech.ts';
import { LlmError } from '../models/llm/types.ts';
import { SpeechError } from '../models/speech/types.ts';
import type { StreamedAudio } from './task-port.ts';
import { NO_STREAM } from './task-port.ts';
import { SpokenReply, openSpokenReply } from './voice.ts';

const live = (): AbortSignal => new AbortController().signal;

function reply(tts: ScriptedTextToSpeech, errors: unknown[] = []) {
  const heard: StreamedAudio[] = [];
  const spoken = new SpokenReply({
    tts,
    signal: live(),
    emit: (chunk) => {
      heard.push(chunk);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { spoken, heard };
}

describe('SpokenReply', () => {
  test('speaks a sentence as soon as it is complete, before the answer has ended', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord(2)]);
    const { spoken, heard } = reply(tts);
    spoken.say('It ships');
    expect(tts.calls).toEqual([]);
    spoken.say(' today. The carrier');
    expect(tts.calls).toEqual(['It ships today. ']);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((chunk) => !chunk.last)).toBe(true);
    spoken.say(' collects at four.');
    await spoken.finish();
    expect(tts.calls).toEqual(['It ships today. ', 'The carrier collects at four.']);
    expect(heard.length).toBe(8);
    expect(heard.map((chunk) => chunk.last)).toEqual([
      ...Array.from({ length: 7 }, () => false),
      true,
    ]);
    expect(heard[0]).toEqual({
      mediaType: 'audio/pcm',
      sampleRate: 24_000,
      channels: 1,
      data: 'AAA=',
      last: false,
    });
  });

  test('sentences that complete while one is being spoken are spoken together', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord()], { delayMs: 5 });
    const { spoken } = reply(tts);
    spoken.say('One. ');
    spoken.say('Two. ');
    spoken.say('Three. ');
    spoken.say('Four');
    await spoken.finish();
    expect(tts.calls).toEqual(['One. ', 'Two. Three. ', 'Four']);
  });

  test('an answer with nothing to say produces no audio at all', async () => {
    const tts = new ScriptedTextToSpeech();
    const { spoken, heard } = reply(tts);
    spoken.say('  \n ');
    await spoken.finish();
    expect(tts.calls).toEqual([]);
    expect(heard).toEqual([]);
  });

  test('a synthesis failure is reported, ends the speech, and never throws', async () => {
    const failure = new SpeechError('scripted', 'scripted/tts', true, 'voice lost');
    const tts = new ScriptedTextToSpeech([[Uint8Array.from([1, 2])], { error: failure }]);
    const errors: unknown[] = [];
    const { spoken, heard } = reply(tts, errors);
    spoken.say('First sentence. ');
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    spoken.say('Second sentence. ');
    spoken.say('Third sentence.');
    await spoken.finish();
    expect(errors).toEqual([failure]);
    expect(tts.calls.length).toBe(2);
    expect(heard.map((chunk) => chunk.last)).toEqual([true]);
  });

  test('an abandoned answer stops being spoken at once, and that is not reported as a failure', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord(2)], { delayMs: 5 });
    const errors: unknown[] = [];
    const { spoken, heard } = reply(tts, errors);
    spoken.say('One two three four five six. ');
    await new Promise((resolve) => {
      setTimeout(resolve, 12);
    });
    spoken.abandon();
    const before = heard.length;
    spoken.say('Never said. ');
    await spoken.finish();
    expect(heard.length).toBe(before);
    expect(heard.every((chunk) => !chunk.last)).toBe(true);
    expect(tts.calls.length).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a step that is already abandoned speaks nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const heard: StreamedAudio[] = [];
    const spoken = new SpokenReply({
      tts: new ScriptedTextToSpeech(),
      signal: controller.signal,
      emit: (chunk) => {
        heard.push(chunk);
      },
    });
    spoken.say('Too late. ');
    await spoken.finish();
    expect(heard).toEqual([]);
  });

  test('is not opened when the turn is not spoken or the sink cannot carry audio', () => {
    const tts = new ScriptedTextToSpeech();
    const ctx = { taskId: 't1', key: 'k1', signal: live(), outcomeUnknown: false };
    const task = {
      taskId: 't1',
      contextId: 'c1',
      longRunning: false,
      model: {
        name: '',
        goal: '',
        description: '',
        acceptanceCriteria: [],
        subTasks: [],
        parentTasks: [],
        participants: [],
        depth: 0,
        schemaVersion: 1 as const,
      },
      state: 'working' as const,
      subState: null,
      llm: null,
      effort: null,
      turnMetadata: {},
    };
    const withAudio = { ...NO_STREAM, audio: () => undefined };
    const speaking = { stt: () => null, tts: () => tts };
    // The sink that drops everything takes text and activity, and has nowhere for audio.
    NO_STREAM.delta('t1', 'k1', 'text');
    NO_STREAM.reset('t1', 'k1');
    NO_STREAM.activity('t1', { kind: 'tool', id: 'c1', name: 'x', phase: 'started' });
    expect('audio' in NO_STREAM).toBe(false);
    expect(openSpokenReply(undefined, withAudio, ctx, task)).toBeNull();
    expect(openSpokenReply({ stt: () => null, tts: () => null }, withAudio, ctx, task)).toBeNull();
    expect(openSpokenReply(speaking, NO_STREAM, ctx, task)).toBeNull();
    expect(openSpokenReply(speaking, withAudio, ctx, task)).toBeInstanceOf(SpokenReply);
  });
});

describe('a spoken answer in the loop', () => {
  test('audio is streamed under the step that wrote the answer, and its last piece is marked', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord(4)]);
    const core = await createCore({
      turns: [say('It ships today. Anything else?')],
      deps: { speech: { stt: () => null, tts: () => tts } },
    });
    await core.send('Where is my order?');
    await core.finished;
    expect(core.audio.length).toBe(5);
    expect(core.audio.at(-1)?.last).toBe(true);
    expect(tts.calls.join('')).toBe('It ships today. Anything else?');
    expect(await core.transcript()).toEqual([
      'user: Where is my order?',
      'agent: It ships today. Anything else?',
    ]);
  });

  test('when the model call fails part-way, what was being said of it stops', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord(2)], { delayMs: 20 });
    const failure = new LlmError('scripted', 'scripted/model', false, 'cut off');
    const core = await createCore({
      turns: [
        () => {
          throw failure;
        },
      ],
      deps: { speech: { stt: () => null, tts: () => tts } },
    });
    await core.send('Where is my order?');
    expect((await core.finished).state).toBe('failed');
    expect(core.audio).toEqual([]);
  });

  test('a failing voice is reported and the answer is delivered regardless', async () => {
    const failure = new SpeechError('scripted', 'scripted/tts', false, 'no voice');
    const failed: string[] = [];
    const core = await createCore({
      turns: [say('It ships today.')],
      deps: {
        speech: {
          stt: () => null,
          tts: () => new ScriptedTextToSpeech([{ error: failure }]),
          onError: (taskId, error) => {
            failed.push(`${taskId}: ${error instanceof Error ? error.message : ''}`);
          },
        },
      },
    });
    await core.send('Where is my order?');
    expect((await core.finished).state).toBe('completed');
    expect(failed).toEqual(['t1: no voice']);
    expect(core.audio).toEqual([]);
  });
});
