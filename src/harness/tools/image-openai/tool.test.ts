/**
 * The `generate_image` tool against canned responses of OpenAI's image API. The fixtures
 * under `test/fixtures/images/openai/` are hand-written — see the README there.
 */
import { describe, expect, test } from 'bun:test';

import { json, replay } from '../../../../test/support/llm-http.ts';
import { PNG_1X1, mediaFixture } from '../../../../test/support/media.ts';
import type { ToolCallContext } from '../types.ts';
import { GENERATE_IMAGE, OPENAI_IMAGE_MODEL, createGenerateImageTool } from './tool.ts';

const KEY = 'sk-fixture-secret-key-0005';
const fixture = (name: string): string => mediaFixture('images', 'openai', name);

function call(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return { taskId: 't1', callId: 'c1', key: 't1/3/tool.invoke/c1', signal };
}

describe('generate_image', () => {
  test('is a tool named generate_image that needs a prompt and is not safe to repeat', () => {
    const tool = createGenerateImageTool({ apiKey: KEY });
    expect(tool.ref).toEqual({ kind: 'tool', id: GENERATE_IMAGE, version: null });
    expect(tool.retrySafe).toBe(false);
    expect(tool.inputSchema['required']).toEqual(['prompt']);
    expect(tool.description.length > 0).toBe(true);
  });

  test('asks the image API for one PNG and returns it as an artifact, not as text', async () => {
    const http = replay(json(200, fixture('image.json')));
    const tool = createGenerateImageTool({ apiKey: KEY, fetch: http.fetch });
    const result = await tool.invoke({ prompt: 'a ceramic lamp', size: '1536x1024' }, call());
    expect(http.requests[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(http.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(http.requests[0]?.body).toEqual({
      model: OPENAI_IMAGE_MODEL,
      prompt: 'a ceramic lamp',
      n: 1,
      output_format: 'png',
      size: '1536x1024',
    });
    expect(result.ok && result.artifacts).toEqual([
      {
        type: 'file',
        mediaType: 'image/png',
        name: 'image.png',
        source: { kind: 'base64', data: PNG_1X1 },
      },
    ]);
    const shown = result.ok ? JSON.stringify(result.content) : '';
    expect(shown).not.toContain(PNG_1X1);
    expect(shown).toContain('delivered');
  });

  test('ignores a size the API does not offer', async () => {
    const http = replay(json(200, fixture('image.json')));
    const tool = createGenerateImageTool({ apiKey: KEY, model: 'gpt-image-2', fetch: http.fetch });
    await tool.invoke({ prompt: 'a lamp', size: '9999x1' }, call());
    expect(http.requests[0]?.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'a lamp',
      n: 1,
      output_format: 'png',
    });
  });

  test('delivers a link when the API answers with an https URL', async () => {
    const body = JSON.stringify({ created: 1, data: [{ url: 'https://img.example/lamp.png' }] });
    const tool = createGenerateImageTool({ apiKey: KEY, fetch: replay(json(200, body)).fetch });
    const result = await tool.invoke({ prompt: 'a lamp' }, call());
    expect(result.ok && result.artifacts?.[0]).toEqual({
      type: 'file',
      mediaType: 'image/png',
      name: 'image.png',
      source: { kind: 'url', url: 'https://img.example/lamp.png' },
    });
  });

  test('an answer without an image, or with a link that is not https, is an error result', async () => {
    const empty = createGenerateImageTool({
      apiKey: KEY,
      fetch: replay(json(200, fixture('empty.json'))).fetch,
    });
    const first = await empty.invoke({ prompt: 'a lamp' }, call());
    expect(first.ok).toBe(false);
    const plain = JSON.stringify({ created: 1, data: [{ url: 'http://img.example/lamp.png' }] });
    const insecure = createGenerateImageTool({
      apiKey: KEY,
      fetch: replay(json(200, plain)).fetch,
    });
    expect((await insecure.invoke('not an object', call())).ok).toBe(false);
  });

  test('a provider failure is an error result that carries no upstream text', async () => {
    const body = JSON.stringify({ error: { message: `no credit for ${KEY}`, code: 'billing' } });
    const tool = createGenerateImageTool({ apiKey: KEY, fetch: replay(json(402, body)).fetch });
    const result = await tool.invoke({ prompt: 'a lamp' }, call());
    expect(result.ok).toBe(false);
    const message = result.ok ? KEY : result.error.message;
    expect(message).toContain('402');
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('no credit');
  });
});
