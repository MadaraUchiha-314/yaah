import { describe, expect, test } from 'bun:test';

import { createCore, last } from '../../../test/support/core.ts';
import { PNG_1X1, WAV_STUB } from '../../../test/support/media.ts';
import { call, callTools, say } from '../../testing/scripted-llm.ts';
import { ScriptedSpeechToText } from '../../testing/scripted-speech.ts';
import { anthropicCapabilities } from '../models/llm/anthropic/provider.ts';
import { buildParams } from '../models/llm/anthropic/request.ts';
import type { LlmContent, LlmRequest } from '../models/llm/types.ts';
import { SpeechError } from '../models/speech/types.ts';
import { defineTool } from '../tools/types.ts';
import { estimateTokens } from './context/builder.ts';
import { modalityOf } from './modalities.ts';
import type { ContentPart } from './types.ts';

const image: ContentPart = {
  type: 'file',
  mediaType: 'image/png',
  source: { kind: 'base64', data: PNG_1X1 },
};
const voice: ContentPart = {
  type: 'file',
  mediaType: 'audio/wav',
  source: { kind: 'base64', data: WAV_STUB },
};
const linked = (url: string): ContentPart => ({
  type: 'file',
  mediaType: 'image/jpeg',
  source: { kind: 'url', url },
});
const text = (value: string): ContentPart => ({ type: 'text', text: value });

/** The content of the user messages of a request, flattened. */
function userContent(request: LlmRequest | undefined): LlmContent[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => [...message.content]);
}

const speech = (stt: ScriptedSpeechToText | null) => ({
  speech: { stt: () => stt, tts: () => null },
});

describe('images and audio on their way to a model', () => {
  test('tells an image from audio from any other file', () => {
    expect(modalityOf({ type: 'file', mediaType: 'image/webp', source: image.source })).toBe(
      'image',
    );
    expect(modalityOf({ type: 'file', mediaType: 'audio/ogg', source: image.source })).toBe(
      'audio',
    );
    expect(
      modalityOf({ type: 'file', mediaType: 'application/pdf', source: image.source }),
    ).toBeNull();
  });

  test('an inline image goes to a model that accepts images, as it is', async () => {
    const core = await createCore({ turns: [say('A lamp.')], capabilities: { input: ['image'] } });
    await core.deliver({ kind: 'message', parts: [text('What is this?'), image] });
    await core.finished;
    expect(userContent(core.llm.requests[0])).toEqual([text('What is this?'), image]);
  });

  test('a turn with an image for a text-only model is answered without calling the model', async () => {
    const core = await createCore({ turns: [say('never said')] });
    await core.deliver({ kind: 'message', parts: [text('What is this?'), image] });
    expect(await core.finished).toEqual({ state: 'completed', subState: null });
    expect(core.llm.requests.length).toBe(0);
    const answer = last(core.tasks.history)?.message ?? [];
    const said = answer.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(said).toContain('scripted/model');
    expect(said).toContain('image');
    expect((await core.transcript()).at(-1)).toBe(`agent: ${said}`);
    expect([...core.tasks.replies.values()].at(-1)).toEqual(answer);
  });

  test('a later turn is not stuck on a file an earlier turn was refused for', async () => {
    const core = await createCore({ turns: [say('Text is fine.')], task: { longRunning: true } });
    await core.deliver({ kind: 'message', parts: [image] });
    await core.statuses(2);
    await core.send('Then just tell me a joke.');
    await core.statuses(4);
    expect(core.llm.requests.length).toBe(1);
    const shown = userContent(core.llm.requests[0]);
    expect(shown.some((part) => part.type === 'file')).toBe(false);
    expect(JSON.stringify(shown)).toContain('image content');
    expect(JSON.stringify(shown)).toContain('Then just tell me a joke.');
  });

  test('an https link is passed on only when the provider fetches links itself', async () => {
    const able = await createCore({
      turns: [say('ok')],
      capabilities: { input: ['image'], inputUrls: ['image'] },
    });
    await able.deliver({ kind: 'message', parts: [linked('https://img.example/a.jpg')] });
    await able.finished;
    expect(userContent(able.llm.requests[0])).toEqual([linked('https://img.example/a.jpg')]);

    const unable = await createCore({ turns: [say('no')], capabilities: { input: ['image'] } });
    await unable.deliver({ kind: 'message', parts: [linked('https://img.example/a.jpg')] });
    await unable.finished;
    expect(unable.llm.requests.length).toBe(0);
    expect(JSON.stringify(last(unable.tasks.history)?.message)).toContain('link');
  });

  test('a link that is not https is never passed on', async () => {
    for (const url of ['http://img.example/a.jpg', 'file:///etc/passwd', 'not a url']) {
      // oxlint-disable-next-line no-await-in-loop -- one small core at a time
      const core = await createCore({
        turns: [say('no')],
        capabilities: { input: ['image'], inputUrls: ['image'] },
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await core.deliver({ kind: 'message', parts: [linked(url)] });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await core.finished;
      expect(core.llm.requests.length).toBe(0);
    }
  });

  test('audio for a text-only model is transcribed once, and the transcript is what the model sees', async () => {
    const stt = new ScriptedSpeechToText(['Where is my order?']);
    const core = await createCore({
      turns: [say('It ships today.'), say('Yes.')],
      task: { longRunning: true },
      deps: speech(stt),
    });
    await core.deliver({ kind: 'message', parts: [voice] });
    await core.statuses(2);
    expect(userContent(core.llm.requests[0])).toEqual([text('Where is my order?')]);
    expect(stt.calls[0]?.mediaType).toBe('audio/wav');
    expect([...(stt.calls[0]?.data ?? [])]).toEqual([...Buffer.from(WAV_STUB, 'base64')]);

    await core.send('Are you sure?');
    await core.statuses(4);
    expect(stt.calls.length).toBe(1);
    expect(JSON.stringify(userContent(core.llm.requests[1]))).toContain('Where is my order?');
    expect(await core.persistence.state.names(core.taskId)).toContain('yaah.transcript/0/0');
  });

  test('audio goes to a model that accepts audio untouched, with no transcription', async () => {
    const stt = new ScriptedSpeechToText(['unused']);
    const core = await createCore({
      turns: [say('Heard.')],
      capabilities: { input: ['audio'] },
      deps: speech(stt),
    });
    await core.deliver({ kind: 'message', parts: [voice] });
    await core.finished;
    expect(userContent(core.llm.requests[0])).toEqual([voice]);
    expect(stt.calls.length).toBe(0);
  });

  test('audio with no speech-to-text model is refused, naming the model and the modality', async () => {
    const core = await createCore({ turns: [say('never')], deps: speech(null) });
    await core.deliver({ kind: 'message', parts: [voice] });
    await core.finished;
    expect(core.llm.requests.length).toBe(0);
    const said = JSON.stringify(last(core.tasks.history)?.message);
    expect(said).toContain('audio');
    expect(said).toContain('scripted/model');
  });

  test('a failed transcription fails the turn instead of sending the model nothing', async () => {
    const stt = new ScriptedSpeechToText([
      { error: new SpeechError('scripted', 'scripted/stt', false, 'cannot hear') },
    ]);
    const core = await createCore({ turns: [say('never')], deps: speech(stt) });
    await core.deliver({ kind: 'message', parts: [voice] });
    expect((await core.finished).state).toBe('failed');
    expect(core.llm.requests.length).toBe(0);
  });

  test('a file that answers an ask_user question is prepared the same way', async () => {
    const stt = new ScriptedSpeechToText(['Store credit, please.']);
    const core = await createCore({
      turns: [callTools(call('q1', 'ask_user', { question: 'Which?' })), say('Done.')],
      deps: speech(stt),
    });
    await core.send('Refund me.');
    await core.statuses(2);
    await core.deliver({ kind: 'message', parts: [voice] });
    await core.finished;
    expect(JSON.stringify(core.llm.requests[1]?.messages)).toContain('Store credit, please.');
  });

  test('what a tool made for the person becomes an artifact, not conversation', async () => {
    const draw = defineTool({
      id: 'draw',
      description: 'Draw.',
      inputSchema: { type: 'object' },
      invoke: () =>
        Promise.resolve({
          ok: true,
          content: [text('The drawing was delivered.')],
          artifacts: [image],
        }),
    });
    const core = await createCore({
      turns: [callTools(call('c1', 'draw')), say('Here it is.')],
      tools: [draw],
    });
    await core.send('Draw a lamp.');
    await core.finished;
    expect([...core.tasks.artifacts.values()]).toEqual([[image]]);
    expect([...core.tasks.artifacts.keys()][0]).toContain('/tool.invoke/c1');
    const stored = JSON.stringify(await core.persistence.conversation.read(core.taskId));
    expect(stored).toContain('The drawing was delivered.');
    expect(stored).not.toContain(PNG_1X1);
    expect(JSON.stringify(core.llm.requests[1]?.messages)).not.toContain(PNG_1X1);
  });

  test('a tool result with a file no model takes reaches an Anthropic model as a note', async () => {
    const files: ContentPart[] = [
      {
        type: 'file',
        mediaType: 'application/octet-stream',
        source: { kind: 'base64', data: 'AA==' },
      },
      { type: 'file', mediaType: 'application/pdf', source: { kind: 'base64', data: 'AA==' } },
      { type: 'file', mediaType: 'image/svg+xml', source: { kind: 'base64', data: 'AA==' } },
    ];
    const fetchFile = defineTool({
      id: 'fetch_file',
      description: 'Fetch a file.',
      inputSchema: { type: 'object' },
      invoke: () => Promise.resolve({ ok: true, content: [text('Here it is.'), ...files] }),
    });
    const capabilities = anthropicCapabilities('claude-opus-5-5');
    const core = await createCore({
      turns: [callTools(call('c1', 'fetch_file')), say('I cannot open it.')],
      tools: [fetchFile],
      capabilities,
    });
    await core.send('Read the file.');
    expect(await core.finished).toEqual({ state: 'completed', subState: null });
    const request = core.llm.requests[1];
    const shown = JSON.stringify(request?.messages);
    expect(shown).not.toContain('"type":"file"');
    expect(shown).toContain('file content');
    expect(shown).toContain('image content');
    expect(() =>
      buildParams(request ?? { messages: [], tools: [] }, 'claude-opus-5-5', capabilities),
    ).not.toThrow();
  });

  test('an inline file counts as a fixed size in the token estimate', () => {
    const big = { kind: 'base64', data: 'A'.repeat(4_000_000) };
    const estimate = estimateTokens([{ type: 'file', mediaType: 'image/png', source: big }]);
    expect(estimate).toBeLessThan(2000);
    expect(estimateTokens({ text: 'x'.repeat(400) })).toBeGreaterThan(100);
  });
});
