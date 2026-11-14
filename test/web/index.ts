/**
 * Everything a web test imports that needs a DOM, behind one door. The first import below
 * registers the DOM; everything else is imported dynamically after it, so every module —
 * React DOM, the A2UI custom elements, the chat's own components — is evaluated with a
 * browser present, whichever web test file the runner happens to load first. (A static
 * import would not do: Bun evaluates the CommonJS modules of a graph, React DOM among
 * them, before the first ES module body runs.) Web test files import these modules from
 * here only.
 */
// oxlint-disable-next-line import/no-unassigned-import -- registers the DOM before the imports below are evaluated
import './dom.ts';

import { forgetModules, useDom } from './dom.ts';

export type { RenderResult } from '@testing-library/react';
export type { ActionMessage } from '../../src/surface/renderer/web/a2ui/stage.ts';
export type { Chat, ChatSession } from '../../src/surface/renderer/web/use-chat.ts';

// The server side loads Lit too (through `@a2ui/agent`), and Lit decides once, when it is
// evaluated, whether it has a browser. A server test that ran first would leave the web
// tests a Lit without one; forgetting those modules makes the imports below evaluate them
// again, now with the DOM. What the server already imported keeps its own copies.
forgetModules(/[/\\]node_modules[/\\](?:lit|lit-html|lit-element|@lit|@lit-labs|@a2ui)[/\\]/u);

export const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import('@testing-library/react');
export const { A2uiStage } = await import('../../src/surface/renderer/web/a2ui/stage.ts');
export const { Fallback, KNOWN_COMPONENTS, webCatalog } =
  await import('../../src/surface/renderer/web/a2ui/catalog.tsx');
export const { nameControls, watchControls } =
  await import('../../src/surface/renderer/web/a2ui/label-repair.ts');
export const { App } = await import('../../src/surface/renderer/web/app.tsx');
export const { ChatScreen } = await import('../../src/surface/renderer/web/chat.tsx');
export const { A2uiBlock, SurfaceBoundary } =
  await import('../../src/surface/renderer/web/components/a2ui-block.tsx');
export const { Composer } = await import('../../src/surface/renderer/web/components/composer.tsx');
export const { StatePill } =
  await import('../../src/surface/renderer/web/components/state-pill.tsx');
export const { TaskHeader } =
  await import('../../src/surface/renderer/web/components/task-header.tsx');
export const { ToolGroup } =
  await import('../../src/surface/renderer/web/components/tool-group.tsx');
export const { AskBlock, Transcript } =
  await import('../../src/surface/renderer/web/components/transcript.tsx');
export const { useChat } = await import('../../src/surface/renderer/web/use-chat.ts');

/** Call once at the top of a web test file. */
export function webTest(): void {
  useDom(cleanup);
}
