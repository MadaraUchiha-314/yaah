/**
 * The OpenAI speech and image plugins: what each registers from the configuration, how it
 * treats a missing credential, and that the key it reads is handed to the redactor.
 */
import { describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import * as sttPlugin from '../../src/harness/models/speech/openai-stt/index.ts';
import * as ttsPlugin from '../../src/harness/models/speech/openai-tts/index.ts';
import { transcriptOf } from '../../src/harness/models/speech/types.ts';
import { definePrompt } from '../../src/harness/system-prompt/prompt.ts';
import * as imagePlugin from '../../src/harness/tools/image-openai/index.ts';
import type { YaahConfig } from '../../src/kernel/config-types.ts';
import { defaultConfig, parseConfig } from '../../src/kernel/config.ts';
import { ConfigError } from '../../src/kernel/errors.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { EntityRegistry } from '../../src/kernel/registry.ts';
import { json, replay, sse } from '../support/llm-http.ts';
import { mediaFixture, scriptedSockets } from '../support/media.ts';

const KEY = 'sk-fixture-secret-key-0004';
const ENV = 'YAAH_TEST_SPEECH_KEY';
const live = (): AbortSignal => new AbortController().signal;

interface Fixture {
  readonly ctx: Context;
  readonly registry: EntityRegistry;
  readonly redactor: Redactor;
}

function harness(config: YaahConfig): Fixture {
  const ctx = new Context();
  const registry = new EntityRegistry();
  const redactor = new Redactor();
  ctx.provide('entities', registry);
  ctx.provide('config', config);
  ctx.provide('redactor', redactor);
  return { ctx, registry, redactor };
}

function configured(extra = ''): YaahConfig {
  return parseConfig(`[providers.openai]\napi_key_env = "${ENV}"\n${extra}`, 'test.toml');
}

async function withEnv(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const before = process.env[ENV];
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
  try {
    await body();
  } finally {
    if (before === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = before;
    }
  }
}

async function startError(ctx: Context, plugin: Parameters<Context['use']>[0]): Promise<unknown> {
  try {
    await ctx.use(plugin, undefined);
  } catch (error) {
    return error;
  }
  return null;
}

describe('speech configuration', () => {
  test('no speech model is used unless the configuration names one', () => {
    const config = defaultConfig();
    expect(config.speech).toEqual({ stt: '', tts: '' });
    expect(config.providers.openai.sttModel).toBe('gpt-transcribe');
    expect(config.providers.openai.ttsModel).toBe('gpt-realtime-2.1-mini');
    expect(config.providers.openai.ttsVoice).toBe('marin');
    expect(config.providers.openai.imageModel).toBe('gpt-image-2.5-flare');
    const chosen = parseConfig('[speech]\nstt = "mine/stt"\ntts = "mine/tts"', 'test.toml');
    expect(chosen.speech).toEqual({ stt: 'mine/stt', tts: 'mine/tts' });
  });
});

describe('speech-openai-stt plugin', () => {
  test('declares its name and the services it needs', () => {
    expect(sttPlugin.name).toBe('speech-openai-stt');
    expect([...sttPlugin.inject].toSorted()).toEqual(['config', 'entities', 'redactor']);
  });

  test('registers the configured model with the key from the environment', async () => {
    await withEnv(KEY, async () => {
      const http = replay(sse(mediaFixture('speech', 'openai', 'transcription.sse')));
      const { ctx, registry, redactor } = harness(configured('stt_model = "gpt-4o-transcribe"'));
      await ctx.use(sttPlugin, { fetch: http.fetch });
      const model = registry.resolve({
        kind: 'speech-to-text',
        id: 'openai/gpt-4o-transcribe',
        version: null,
      });
      expect(redactor.contains(`Bearer ${KEY}`)).toBe(true);
      const audio = { data: Uint8Array.from([1, 2]), mediaType: 'audio/wav' };
      expect(await transcriptOf(model, audio, live())).toBe('Where is my order?');
    });
  });

  test('without a key it registers nothing and says so once the harness is ready', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured());
      const said: string[][] = [];
      ctx.on('speech/unavailable', (id: string, variable: string) => {
        said.push([id, variable]);
      });
      await ctx.use(sttPlugin, undefined);
      expect(registry.list('speech-to-text')).toEqual([]);
      await ctx.parallel('harness/ready');
      expect(said).toEqual([['openai/gpt-transcribe', ENV]]);
    });
  });

  test('without a key it refuses to start when speech.stt names this model', async () => {
    await withEnv(undefined, async () => {
      const { ctx } = harness(configured('[speech]\nstt = "openai/gpt-transcribe"'));
      const caught = await startError(ctx, sttPlugin);
      expect(caught instanceof ConfigError && caught.code).toBe('config.credential');
      expect(caught instanceof Error ? caught.message : '').toContain(ENV);
    });
  });
});

describe('speech-openai-tts plugin', () => {
  test('declares its name and the services it needs', () => {
    expect(ttsPlugin.name).toBe('speech-openai-tts');
    expect([...ttsPlugin.inject].toSorted()).toEqual(['config', 'entities', 'redactor']);
  });

  test('registers the configured model and voice, and reads its instructions from a prompt', async () => {
    const sockets = scriptedSockets({
      events: mediaFixture('speech', 'openai', 'realtime-speech.jsonl'),
    });
    const { ctx, registry, redactor } = harness(
      configured('tts_model = "gpt-realtime-2.1"\ntts_voice = "cedar"'),
    );
    registry.register(definePrompt({ id: 'speech', template: 'Read it aloud.' }));
    await ctx.use(ttsPlugin, { apiKey: KEY, socket: sockets.open });
    const model = registry.resolve({
      kind: 'text-to-speech',
      id: 'openai/gpt-realtime-2.1',
      version: null,
    });
    expect(redactor.contains(KEY)).toBe(true);
    let bytes = 0;
    for await (const chunk of model.synthesize('Hello there.', live())) {
      bytes += chunk.length;
    }
    expect(bytes).toBe(12);
    expect(JSON.stringify(sockets.connections[0]?.sent)).toContain('Read it aloud.');
    expect(JSON.stringify(sockets.connections[0]?.sent)).toContain('cedar');
    expect(sockets.connections[0]?.url).toContain('model=gpt-realtime-2.1');
  });

  test('without a key it registers nothing and says so once the harness is ready', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured());
      const said: string[][] = [];
      ctx.on('speech/unavailable', (id: string, variable: string) => {
        said.push([id, variable]);
      });
      await ctx.use(ttsPlugin, undefined);
      expect(registry.list('text-to-speech')).toEqual([]);
      await ctx.parallel('harness/ready');
      expect(said).toEqual([['openai/gpt-realtime-2.1-mini', ENV]]);
    });
  });

  test('without a key it refuses to start when speech.tts names this model', async () => {
    await withEnv(undefined, async () => {
      const { ctx } = harness(configured('[speech]\ntts = "openai/gpt-realtime-2.1-mini"'));
      const caught = await startError(ctx, ttsPlugin);
      expect(caught instanceof ConfigError && caught.key).toBe('providers.openai.api_key_env');
    });
  });
});

describe('tool-image-openai plugin', () => {
  test('declares its name and the services it needs', () => {
    expect(imagePlugin.name).toBe('tool-image-openai');
    expect([...imagePlugin.inject].toSorted()).toEqual(['config', 'entities', 'redactor']);
  });

  test('registers generate_image with the configured model when there is a key', async () => {
    await withEnv(KEY, async () => {
      const http = replay(json(200, mediaFixture('images', 'openai', 'image.json')));
      const { ctx, registry, redactor } = harness(configured('image_model = "gpt-image-2"'));
      await ctx.use(imagePlugin, { fetch: http.fetch });
      const tool = registry.resolve({ kind: 'tool', id: 'generate_image', version: null });
      expect(redactor.contains(KEY)).toBe(true);
      const result = await tool.invoke(
        { prompt: 'a lamp' },
        { taskId: 't1', callId: 'c1', key: 'k1', signal: live() },
      );
      expect(result.ok).toBe(true);
      expect(http.requests[0]?.body['model']).toBe('gpt-image-2');
    });
  });

  test('without a key the tool is not registered, so no model is offered it', async () => {
    await withEnv(undefined, async () => {
      const { ctx, registry } = harness(configured());
      await ctx.use(imagePlugin, undefined);
      expect(registry.list('tool')).toEqual([]);
    });
  });
});
