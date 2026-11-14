// Type-aware lint reads this file outside tsconfig.json (it is in tsconfig.web.json), so it names its runner types.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { EMPTY_VIEW } from '../../src/surface/view.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { rendererContract } from '../../src/testing/renderer-contract.ts';
import { TaskHeader, Transcript, act, render, webTest } from '../web/index.ts';

webTest();

/** Draws the header and the transcript of a view, and returns the text a person would read. */
async function renderToText(view: TaskView): Promise<string> {
  const drawn = render(
    <>
      <TaskHeader
        view={view}
        dashboardUrl={null}
        busy={false}
        onComplete={() => undefined}
        onCancel={() => undefined}
      />
      <Transcript view={view} commands={[]} onAction={() => undefined} />
    </>,
  );
  // The A2UI elements render in a microtask after they connect.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });
  const text = drawn.container.textContent;
  drawn.unmount();
  return text;
}

rendererContract({ describe, expect, test }, 'web', renderToText);

describe('renderer contract: web, beyond the shared cases', () => {
  /**
   * Feature: Surfaces and renderers
   * Scenario: The empty view names its state too
   *   Given a view before anything was said
   *   When it is drawn
   *   Then the state is named in words
   * Requirement: docs/specs/issue-3/requirements.md R20.3
   */
  test('The empty view names its state too', async () => {
    expect(await renderToText(EMPTY_VIEW)).toContain('Ready');
  });
});
