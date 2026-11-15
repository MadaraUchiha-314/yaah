import { afterEach, describe, expect, test } from 'bun:test';

import {
  A2UI_CAPABILITIES_KEY,
  A2UI_EXTENSION,
  A2UI_MEDIA_TYPE,
  BASIC_CATALOG_ID,
} from '../../src/harness/a2ui/index.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const offered = { [A2UI_CAPABILITIES_KEY]: { '1.0': { supportedCatalogIds: [BASIC_CATALOG_ID] } } };
const FORM = [
  'Here is the form.',
  '<a2ui>',
  'root = Column([Text("Refund details"), Button(Text("Submit"), action=Event("submitRefund"))])',
  '</a2ui>',
  'Fill it in when ready.',
].join('\n');

async function artifactParts(harness: TestHarness, taskId: string) {
  const task = await harness.client.getTask({ tenant: '', id: taskId });
  return task.artifacts.flatMap((artifact) => artifact.parts);
}

describe('A2UI', () => {
  /**
   * Feature: Surfaces and renderers
   * Scenario: The agent answers with a basic-catalog A2UI surface
   *   Given a client that says it can render the A2UI basic catalog
   *   When the model writes text and an A2UI block
   *   Then the model was taught the A2UI output format for this turn
   *   And the answer carries the text and a part of validated A2UI messages
   *   And the raw A2UI markup is never streamed to the client as text
   * Requirement: docs/specs/issue-3/requirements.md R19.4, R19.6
   */
  test('The agent answers with a basic-catalog A2UI surface', async () => {
    running = await startHarness({ turns: [say(FORM)] });
    const turn = await running.send('I want a refund', {
      metadata: offered,
      extensions: [A2UI_EXTENSION],
    });
    expect(JSON.stringify(running.llm.requests[0]?.messages)).toContain('<a2ui>');
    expect(turn.streamed).toContain('Here is the form.');
    expect(turn.streamed).not.toContain('<a2ui>');
    expect(turn.streamed).not.toContain('root =');

    const parts = await artifactParts(running, turn.task?.id ?? '');
    // The surface may arrive progressively, as several parts: read them all.
    const data = parts.filter((part) => part.mediaType === A2UI_MEDIA_TYPE);
    expect(data.length).toBeGreaterThan(0);
    const messages = JSON.stringify(
      data.map((part) => (part.content?.$case === 'data' ? (part.content.value as unknown) : null)),
    );
    expect(messages).toContain('createSurface');
    expect(messages).toContain(BASIC_CATALOG_ID);
    expect(messages).toContain('submitRefund');
    const texts = parts.map((part) => (part.content?.$case === 'text' ? part.content.value : ''));
    expect(texts.join('|')).toContain('Fill it in when ready.');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A client that does not offer A2UI gets text only
   *   Given a client that offers no A2UI catalog
   *   When a message is sent
   *   Then the model is not taught A2UI and what it writes is passed on as text
   * Requirement: docs/specs/issue-3/requirements.md R19.5
   */
  test('A client that does not offer A2UI gets text only', async () => {
    running = await startHarness({ turns: [say('Plain answer.')] });
    const turn = await running.send('Hello');
    expect(JSON.stringify(running.llm.requests[0]?.messages)).not.toContain('<a2ui>');
    const parts = await artifactParts(running, turn.task?.id ?? '');
    expect(parts.every((part) => part.content?.$case === 'text')).toBe(true);
  });

  /**
   * Feature: Security
   * Scenario: A2UI that names a component outside the catalog is dropped
   *   Given a client that offers the basic catalog
   *   When the model writes an A2UI block with a component the catalog does not have
   *   Then no A2UI part leaves the harness, the surrounding text does, and the rejection is reported
   * Requirement: docs/specs/issue-3/requirements.md abuse case 5
   */
  test('A2UI that names a component outside the catalog is dropped', async () => {
    const rejected: string[] = [];
    running = await startHarness({
      turns: [say('Before.\n<a2ui>\nroot = ScriptTag("alert(1)")\n</a2ui>\nAfter.')],
      setup: (ctx) => {
        ctx.on('a2ui/rejected', (_taskId, reason) => {
          rejected.push(reason);
        });
      },
    });
    const turn = await running.send('Go', { metadata: offered });
    const parts = await artifactParts(running, turn.task?.id ?? '');
    expect(parts.some((part) => part.mediaType === A2UI_MEDIA_TYPE)).toBe(false);
    const text = parts
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    expect(text).toContain('Before.');
    expect(text).toContain('After.');
    expect(text).not.toContain('ScriptTag');
    expect(rejected.length).toBe(1);
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: An <a2ui> tag that is never closed is kept as text
   *   Given a client that offers the basic catalog
   *   When the model only mentions the <a2ui> tag, or its reply is cut off inside a block
   *        before any of the block is valid
   *   Then the whole answer reaches the client as text, from the tag on too
   *   And no A2UI part leaves the harness
   *   When a reply is cut off inside a block of which a surface could be read
   *   Then that surface leaves the harness and the block's markup is not shown as text
   * Requirement: docs/specs/issue-3/requirements.md R19.4; abuse case 5
   */
  test('An <a2ui> tag that is never closed is kept as text', async () => {
    const mention = 'To write UI you use the <a2ui> tag. The answer is 42.';
    const cut = 'Here is the form.\n<a2ui>\nroot = Col';
    const partial = 'Here is the form.\n<a2ui>\nroot = Column([Text("Refund';
    running = await startHarness({ turns: [say(mention), say(cut), say(partial)] });
    const answer = async (): Promise<{ text: string; ui: boolean }> => {
      const turn = await running?.send('Go', { metadata: offered });
      const parts = running === undefined ? [] : await artifactParts(running, turn?.task?.id ?? '');
      const text = parts
        .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
        .join('');
      return { text, ui: parts.some((part) => part.mediaType === A2UI_MEDIA_TYPE) };
    };
    expect(await answer()).toEqual({ text: mention, ui: false });
    expect(await answer()).toEqual({ text: cut, ui: false });
    const shown = await answer();
    expect(shown.ui).toBe(true);
    expect(shown.text).not.toContain('<a2ui>');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A user's action on an A2UI surface reaches the model
   *   Given a long-running task that showed an A2UI form
   *   When the client sends the user's action as an A2UI data part
   *   Then the model is shown the action and answers
   * Requirement: docs/specs/issue-3/requirements.md R19.4
   */
  test("A user's action on an A2UI surface reaches the model", async () => {
    running = await startHarness({ turns: [say(FORM), say('Refund filed.')] });
    const lifecycle = 'https://github.com/MadaraUchiha-314/yaah/extensions/task-lifecycle/v1';
    const first = await running.send('I want a refund', {
      metadata: { ...offered, [lifecycle]: { longRunning: true } },
    });
    const taskId = first.task?.id ?? '';
    const action = {
      version: '1.0',
      action: {
        name: 'submitRefund',
        surfaceId: 's1',
        sourceComponentId: 'b1',
        context: { reason: 'damaged' },
      },
    };
    const message = {
      ...running.message('', { taskId, metadata: offered }),
      parts: [
        {
          content: { $case: 'data' as const, value: [action] },
          metadata: undefined,
          filename: '',
          mediaType: A2UI_MEDIA_TYPE,
        },
      ],
    };
    for await (const event of running.client.sendMessageStream({
      tenant: '',
      message,
      configuration: undefined,
      metadata: undefined,
    })) {
      expect(event.payload).toBeDefined();
    }
    const shown = JSON.stringify(running.llm.requests[1]?.messages);
    expect(shown).toContain('submitRefund');
    expect(shown).toContain('damaged');
  });

  /**
   * Feature: A2A API server
   * Scenario: The agent card advertises A2UI
   *   Given a running harness
   *   When the card is read
   *   Then it lists the official A2UI extension with the basic catalog
   * Requirement: docs/specs/issue-3/requirements.md R13.3, R19.6
   */
  test('The agent card advertises A2UI', async () => {
    running = await startHarness({});
    const card = await running.client.getAgentCard();
    const extension = card.capabilities?.extensions.find((entry) => entry.uri === A2UI_EXTENSION);
    expect(extension?.params).toEqual({
      supportedCatalogIds: [BASIC_CATALOG_ID],
      acceptsInlineCatalogs: false,
    });
  });
});
