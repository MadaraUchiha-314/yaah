import { createServer } from 'node:http';

import type { Part, StreamResponse } from '@a2a-js/sdk';
import { afterEach, describe, expect, test } from 'bun:test';

import { createGenerateImageTool } from '../../src/harness/tools/image-openai/tool.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness, statusText } from '../support/harness.ts';
import { json, replay } from '../support/llm-http.ts';
import { PNG_1X1, mediaFixture, rawPart, urlPart } from '../support/media.ts';
import { renderToText } from '../support/tui.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** The file parts of every artifact update of a stream, in arrival order. */
function artifactFiles(events: readonly StreamResponse[]): { name: string; part: Part }[] {
  return events.flatMap((event) => {
    const artifact =
      event.payload?.$case === 'artifactUpdate' ? event.payload.value.artifact : undefined;
    return (artifact?.parts ?? [])
      .filter((part) => part.content?.$case === 'raw' || part.content?.$case === 'url')
      .map((part) => ({ name: artifact?.name ?? '', part }));
  });
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

describe('multi-modal input and image output', () => {
  /**
   * Feature: Multi-modal input
   * Scenario: An image turn reaches a model that accepts images
   *   Given a harness whose selected model accepts images
   *   When a message carries text and a PNG as an A2A raw part
   *   Then the model is called once and is shown the text and the image, byte for byte
   *   And the image is stored with the task's conversation
   * Requirement: docs/specs/issue-3/requirements.md R24.1
   */
  test('An image turn reaches a model that accepts images', async () => {
    running = await startHarness({
      turns: [say('A white pixel.')],
      capabilities: { input: ['image'] },
    });
    const turn = await running.send('What is this?', {
      parts: [rawPart('image/png', PNG_1X1, 'pixel.png')],
    });
    expect(statusText(turn.task)).toBe('A white pixel.');
    expect(running.llm.requests.length).toBe(1);
    const shown = running.llm.requests[0]?.messages.at(-1)?.content;
    expect(shown).toEqual([
      { type: 'text', text: 'What is this?' },
      {
        type: 'file',
        mediaType: 'image/png',
        name: 'pixel.png',
        source: { kind: 'base64', data: PNG_1X1 },
      },
    ]);
    const stored = await running.harness.ctx.persistence.conversation.read(turn.task?.id ?? '');
    expect(JSON.stringify(stored[0])).toContain(PNG_1X1);
  });

  /**
   * Feature: Multi-modal input
   * Scenario: A turn with an unsupported modality is answered without a model call
   *   Given a harness whose selected model accepts text only, and no speech-to-text model
   *   When a message carries an image, and another carries audio
   *   Then each is answered with a reply that names the model and the modality
   *   And the model is never called
   * Requirement: docs/specs/issue-3/requirements.md R24.1
   */
  test('A turn with an unsupported modality is answered without a model call', async () => {
    running = await startHarness({ turns: [say('never said')] });
    const image = await running.send('What is this?', {
      parts: [rawPart('image/png', PNG_1X1)],
    });
    expect(statusText(image.task)).toContain('scripted/model');
    expect(statusText(image.task)).toContain('does not accept image input');
    const audio = await running.send('', { parts: [rawPart('audio/wav', 'UklGRg==')] });
    expect(statusText(audio.task)).toContain('scripted/model');
    expect(statusText(audio.task)).toContain('does not accept audio input');
    expect(running.llm.requests.length).toBe(0);
    expect(running.llm.remaining).toBe(1);
  });

  /**
   * Feature: Multi-modal input
   * Scenario: A linked image is never fetched by the harness
   *   Given a model that accepts images inline but not as links
   *   When a message carries an image as a URL part that points at a server we watch
   *   Then the reply says a link cannot be taken and that the harness does not download links
   *   And the server is never contacted and the model is never called
   * Requirement: docs/specs/issue-3/requirements.md R24.1; abuse case 7
   */
  test('A linked image is never fetched by the harness', async () => {
    let hits = 0;
    const watched = createServer((_request, response) => {
      hits += 1;
      response.end('x');
    });
    await new Promise<void>((resolve) => {
      watched.listen(0, '127.0.0.1', resolve);
    });
    const address = watched.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      running = await startHarness({ turns: [say('never')], capabilities: { input: ['image'] } });
      const turn = await running.send('Look', {
        parts: [urlPart('image/png', `http://127.0.0.1:${String(port)}/a.png`)],
      });
      expect(statusText(turn.task)).toContain('does not download links');
      expect(running.llm.requests.length).toBe(0);
      expect(hits).toBe(0);
    } finally {
      watched.close();
    }
  });

  /**
   * Feature: Multi-modal input
   * Scenario: A part over the size limit is refused before a task exists
   *   Given a harness that accepts parts of at most 2000 bytes
   *   When a message carries a larger image
   *   Then the request fails with a message that states the limit
   *   And no task is created and the model is never called
   * Requirement: docs/specs/issue-3/requirements.md R24.1, R26.4
   */
  test('A part over the size limit is refused before a task exists', async () => {
    running = await startHarness({
      turns: [say('never')],
      capabilities: { input: ['image'] },
      config: '[limits]\nmax_part_bytes = 2000',
    });
    const big = Buffer.alloc(4000, 7).toString('base64');
    let message = '';
    try {
      await running.send('Too big', { parts: [rawPart('image/png', big)] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('2000');
    expect(running.llm.requests.length).toBe(0);
    expect(running.harness.ctx.taskRuntime.taskStore.open().length).toBe(0);
  });

  /**
   * Feature: Image output
   * Scenario: An image the agent generates is delivered as an artifact
   *   Given a harness with the generate_image tool on a canned image API
   *   When the model calls generate_image and then answers
   *   Then the stream carries an artifact whose part is the PNG with media type image/png
   *   And the task keeps that artifact, and the answer text does not contain the image
   *   And the model was told only that the image was delivered
   *   And a surface's view holds the image, which the terminal UI shows as a label and where it is
   * Requirement: docs/specs/issue-3/requirements.md R24.2
   */
  test('An image the agent generates is delivered as an artifact', async () => {
    const http = replay(json(200, mediaFixture('images', 'openai', 'image.json')));
    const turns = () => [
      callTools(call('c1', 'generate_image', { prompt: 'a ceramic lamp' })),
      say('Here is your lamp.'),
    ];
    running = await startHarness({
      turns: [...turns(), ...turns()],
      tools: [createGenerateImageTool({ apiKey: 'sk-fixture-secret-key-0006', fetch: http.fetch })],
      // The shipped plugin would register the same tool when the machine has a key.
      config: '[[overrides]]\nid = "tool-image-openai"\ndisabled = true',
    });
    const turn = await running.send('Draw me a lamp');
    const [delivered] = artifactFiles(turn.events);
    expect(delivered?.name).toBe('attachment');
    expect(delivered?.part.mediaType).toBe('image/png');
    expect(delivered?.part.filename).toBe('image.png');
    const { content } = delivered?.part ?? {};
    expect(content?.$case === 'raw' && Buffer.from(content.value).toString('base64')).toBe(PNG_1X1);
    expect(statusText(turn.task)).toBe('Here is your lamp.');

    const stored = await running.client.getTask({ tenant: '', id: turn.task?.id ?? '' });
    const kept = stored.artifacts.find((artifact) => artifact.name === 'attachment');
    expect(kept?.parts[0]?.mediaType).toBe('image/png');
    const told = JSON.stringify(running.llm.requests[1]?.messages);
    expect(told).toContain('delivered');
    expect(told).not.toContain(PNG_1X1);

    const session = await HarnessSession.connect(running.url);
    const view = await last(session.send({ text: 'Draw me another lamp' }));
    const image = view.items.find((item) => item.kind === 'file');
    expect(image).toMatchObject({
      kind: 'file',
      from: 'agent',
      mediaType: 'image/png',
      name: 'image.png',
      url: `data:image/png;base64,${PNG_1X1}`,
    });
    const drawn = renderToText(view);
    expect(drawn).toContain('[Image] image.png');
    expect(drawn).toContain('kept with the task as');
    expect(drawn).toContain('/tool.invoke/c1/0');
    expect(drawn).not.toContain(PNG_1X1);
    const again = await session.openTasks();
    expect(again.length).toBe(1);
  });
});
