import type { StreamResponse } from '@a2a-js/sdk';
import { afterEach, describe, expect, test } from 'bun:test';

import { EXT, SCHEMAS } from '../../src/app/api-server/extensions/index.ts';
import { SpeechError } from '../../src/harness/models/speech/types.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { SpeechChunk } from '../../src/surface/view-files.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import {
  ScriptedSpeechToText,
  ScriptedTextToSpeech,
  silencePerWord,
} from '../../src/testing/scripted-speech.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';
import { WAV_STUB, rawPart } from '../support/media.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const SPEAK = { metadata: { [EXT.voice]: { output: true } }, extensions: [EXT.voice] };
const SPEECH_CONFIG = '[speech]\nstt = "scripted/stt"\ntts = "scripted/tts"';

/** What kind of event each stream event is, for asserting on order. */
function kinds(events: readonly StreamResponse[]): string[] {
  return events.map((event) => {
    const { payload } = event;
    if (payload?.$case !== 'artifactUpdate') {
      return payload?.$case ?? 'none';
    }
    return payload.value.artifact?.extensions.includes(EXT.voice) === true ? 'speech' : 'text';
  });
}

function speechUpdates(events: readonly StreamResponse[]) {
  return events.flatMap((event) =>
    event.payload?.$case === 'artifactUpdate' &&
    event.payload.value.artifact?.extensions.includes(EXT.voice) === true
      ? [event.payload.value]
      : [],
  );
}

async function last(views: AsyncIterable<TaskView>): Promise<TaskView> {
  let final: TaskView | undefined = undefined;
  for await (const view of views) {
    final = view;
  }
  if (final === undefined) {
    throw new Error('the turn produced no view');
  }
  return final;
}

describe('speech and voice', () => {
  /**
   * Feature: Voice
   * Scenario: An audio turn is transcribed for a text-only model
   *   Given a harness whose selected model accepts text only
   *   And a speech-to-text model named by speech.stt
   *   When a message carries a voice recording as an A2A raw part
   *   Then the recording is transcribed once
   *   And the model is called with the transcript in place of the audio
   *   And the answer is the model's answer to what was said
   * Requirement: docs/specs/issue-3/requirements.md R24.1, R24.3, R24.4
   */
  test('An audio turn is transcribed for a text-only model', async () => {
    const stt = new ScriptedSpeechToText(['Where is my order?']);
    running = await startHarness({
      turns: [say('It ships today.')],
      config: SPEECH_CONFIG,
      setup: (ctx) => {
        registerEntity(ctx, stt);
      },
    });
    const turn = await running.send('', {
      parts: [rawPart('audio/wav', WAV_STUB, 'voice-message.wav')],
    });
    expect(statusText(turn.task)).toBe('It ships today.');
    expect(stt.calls.length).toBe(1);
    expect(stt.calls[0]?.mediaType).toBe('audio/wav');
    expect(running.llm.requests.length).toBe(1);
    expect(running.llm.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Where is my order?' },
    ]);
  });

  /**
   * Feature: Voice
   * Scenario: Spoken output streams audio chunks before the final event
   *   Given a harness with a text-to-speech model named by speech.tts
   *   And a model that answers in several sentences, word by word
   *   When a message asks for spoken output through the voice extension
   *   Then audio/pcm artifact chunks arrive while the text is still streaming
   *   And every one of them arrives before the final status event
   *   And each is appended to one speech artifact, and only the last is marked lastChunk
   *   And each says how to play it: sample rate, channels, encoding
   * Requirement: docs/specs/issue-3/requirements.md R24.5
   */
  test('Spoken output streams audio chunks before the final event', async () => {
    const tts = new ScriptedTextToSpeech([silencePerWord(4)], { delayMs: 1 });
    running = await startHarness({
      turns: [say('It ships today. The carrier collects at four. It arrives on Friday.')],
      llmDelayMs: 8,
      config: SPEECH_CONFIG,
      setup: (ctx) => {
        registerEntity(ctx, tts);
      },
    });
    const turn = await running.send('Where is my order?', SPEAK);
    const order = kinds(turn.events);
    const finalStatus = order.lastIndexOf('statusUpdate');
    const lastSpeech = order.lastIndexOf('speech');
    expect(order.includes('speech')).toBe(true);
    expect(lastSpeech).toBeLessThan(finalStatus);
    // As it is produced: speech starts before the text has finished streaming.
    expect(order.indexOf('speech')).toBeLessThan(order.lastIndexOf('text'));

    const updates = speechUpdates(turn.events);
    expect(updates.length).toBe(12);
    expect(new Set(updates.map((update) => update.artifact?.artifactId)).size).toBe(1);
    expect(updates.every((update) => update.append)).toBe(true);
    expect(updates.map((update) => update.lastChunk)).toEqual([
      ...Array.from({ length: 11 }, () => false),
      true,
    ]);
    for (const update of updates) {
      const [part] = update.artifact?.parts ?? [];
      expect(part?.mediaType).toBe('audio/pcm');
      expect(part?.content?.$case === 'raw' ? part.content.value.length : -1).toBe(4);
      const format: unknown = update.artifact?.metadata?.[EXT.voice];
      expect(SCHEMAS.voiceAudio.parse(format)).toEqual({
        sampleRate: 24_000,
        channels: 1,
        encoding: 's16le',
      });
    }
    expect(statusText(turn.task)).toBe(
      'It ships today. The carrier collects at four. It arrives on Friday.',
    );
    expect(tts.calls.join('')).toBe(statusText(turn.task));
    // Speech is streamed, never stored: the task keeps the text only.
    const stored = await running.client.getTask({ tenant: '', id: turn.task?.id ?? '' });
    expect(stored.artifacts.some((artifact) => artifact.name === 'speech')).toBe(false);
  });

  /**
   * Feature: Voice
   * Scenario: Nothing is spoken unless the turn asks for it and a voice is configured
   *   Given a harness with a text-to-speech model
   *   When a message does not ask for spoken output
   *   Then no audio is produced
   *   And when a harness without a configured voice is asked for spoken output
   *   Then it answers in text alone
   * Requirement: docs/specs/issue-3/requirements.md R24.5
   */
  test('Nothing is spoken unless the turn asks for it and a voice is configured', async () => {
    const tts = new ScriptedTextToSpeech();
    running = await startHarness({
      turns: [say('Quiet answer.'), say('Odd request.')],
      config: SPEECH_CONFIG,
      setup: (ctx) => {
        registerEntity(ctx, tts);
      },
    });
    const quiet = await running.send('Hello');
    expect(kinds(quiet.events).includes('speech')).toBe(false);
    const odd = await running.send('Hello', { metadata: { [EXT.voice]: { output: 'loud' } } });
    expect(kinds(odd.events).includes('speech')).toBe(false);
    expect(tts.calls).toEqual([]);
    await running.stop();

    running = await startHarness({ turns: [say('Text only.')] });
    const unvoiced = await running.send('Hello', SPEAK);
    expect(kinds(unvoiced.events).includes('speech')).toBe(false);
    expect(statusText(unvoiced.task)).toBe('Text only.');
  });

  /**
   * Feature: Voice
   * Scenario: A voice that fails does not fail the answer
   *   Given a text-to-speech model that fails
   *   When a spoken answer is asked for
   *   Then the answer is delivered in text, and the failure is raised as an event
   * Requirement: docs/specs/issue-3/requirements.md R24.5
   */
  test('A voice that fails does not fail the answer', async () => {
    const failed: string[] = [];
    const error = new SpeechError('scripted', 'scripted/tts', false, 'no voice today');
    running = await startHarness({
      turns: [say('Still here.')],
      config: SPEECH_CONFIG,
      setup: (ctx) => {
        registerEntity(ctx, new ScriptedTextToSpeech([{ error }]));
        ctx.on('speech/failed', (taskId: string, reason: string) => {
          failed.push(`${taskId === '' ? 'no task' : 'task'}: ${reason}`);
        });
      },
    });
    const turn = await running.send('Hello', SPEAK);
    expect(statusText(turn.task)).toBe('Still here.');
    expect(failed).toEqual(['task: no voice today']);
  });

  /**
   * Feature: Voice
   * Scenario: The agent card declares the voice extension and a surface uses it
   *   Given a harness with both speech models configured
   *   When a surface reads the card, then sends a voice message asking for a spoken answer
   *   Then the card lists the voice extension with what is configured
   *   And the surface's view shows the voice message it sent
   *   And the surface is handed the spoken answer piece by piece, the last one marked
   * Requirement: docs/specs/issue-3/requirements.md R24.3–24.5, R13.3
   */
  test('The agent card declares the voice extension and a surface uses it', async () => {
    const stt = new ScriptedSpeechToText(['Where is my order?']);
    running = await startHarness({
      turns: [say('It ships today.'), say('Unspoken.')],
      config: SPEECH_CONFIG,
      setup: (ctx) => {
        registerEntity(ctx, stt);
        registerEntity(ctx, new ScriptedTextToSpeech([silencePerWord(6)]));
      },
    });
    const heard: SpeechChunk[] = [];
    const session = await HarnessSession.connect(running.url, {
      onSpeech: (chunk) => {
        heard.push(chunk);
      },
    });
    const declared = session.card.capabilities?.extensions.find((ext) => ext.uri === EXT.voice);
    expect(declared?.params).toEqual({ transcription: true, output: true });
    expect(session.voice).toEqual({ transcription: true, output: true });

    const recording = {
      mediaType: 'audio/wav',
      name: 'voice-message.wav',
      data: Buffer.from(WAV_STUB, 'base64'),
    };
    const view = await last(session.send({ text: '', files: [recording], speak: true }));
    const [sent] = view.items;
    expect(sent).toMatchObject({ kind: 'file', from: 'user', mediaType: 'audio/wav', url: null });
    expect(
      view.items.some((item) => item.kind === 'agent' && item.text === 'It ships today.'),
    ).toBe(true);
    expect(heard.length).toBe(3);
    expect(heard.map((chunk) => chunk.last)).toEqual([false, false, true]);
    expect(heard[0]).toMatchObject({ sampleRate: 24_000, channels: 1 });
    expect(heard[0]?.data.length).toBe(6);
    expect(new Set(heard.map((chunk) => chunk.artifactId)).size).toBe(1);

    // A surface with nowhere to play speech never asks for it.
    const mute = await HarnessSession.connect(running.url);
    await last(mute.send({ text: 'Again?', speak: true }));
    expect(heard.length).toBe(3);
  });
});
