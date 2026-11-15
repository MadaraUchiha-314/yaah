import { afterEach, describe, expect, test } from 'bun:test';

import type { Harness } from '../../src/kernel/bootstrap.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { solidPng } from '../support/png.ts';
import { ensureKey } from './keys.ts';

const MODEL = process.env['YAAH_LIVE_ANTHROPIC_MODEL'] ?? 'claude-haiku-5-5';
const live = ensureKey('ANTHROPIC_API_KEY', 'anthropic') ? test : test.skip;

let harness: Harness | undefined = undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

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

describe('live: Anthropic, images', () => {
  /**
   * Feature: Live providers
   * Scenario: A real model is shown an image a user attached and says what it shows
   *   Given a harness using a Claude model through the Anthropic plugin
   *   When the user sends a small PNG that is one solid red square, and asks its colour
   *   Then the image reaches the model as an A2A raw part, and the answer names the colour
   *   And the surface's view shows the image the user sent
   * Requirement: docs/specs/issue-3/requirements.md R24.1, R27.2
   */
  live(
    'A real model is shown an image a user attached and says what it shows',
    async () => {
      harness = await createHarness({
        config: parseConfig(
          [
            'composition = "server"',
            'data_dir = ":memory:"',
            `model = { llm = "anthropic/${MODEL}", effort = "low" }`,
            '[server]',
            'port = 0',
            '[o11y]',
            'log_level = "error"',
            '[[overrides]]',
            'id = "web-ui"',
            'disabled = true',
          ].join('\n'),
          'live.toml',
        ),
      });
      const session = await HarnessSession.connect(harness.ctx.http.url, { longRunning: false });
      const image = {
        mediaType: 'image/png',
        name: 'square.png',
        data: solidPng(64, [220, 20, 20]),
      };
      const view = await last(
        session.send({
          text: 'What colour is this square? Answer with the one word for the colour.',
          files: [image],
        }),
      );
      const answer = view.items
        .filter((item) => item.kind === 'agent')
        .map((item) => item.text)
        .join('\n');
      expect(answer.toLowerCase()).toContain('red');
      expect(view.items.some((item) => item.kind === 'file' && item.from === 'user')).toBe(true);
      expect(view.state).toBe('completed');
    },
    120_000,
  );
});
