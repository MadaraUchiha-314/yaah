/**
 * The entry point of the browser build's page: starts a harness in this tab and mounts
 * the web chat on it. Nothing here talks to a yaah server — the session reaches the
 * harness through its in-memory target.
 */
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is the import's whole purpose
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../../surface/renderer/web/app.tsx';
import { installBufferShim } from '../../surface/renderer/web/lib/buffer-shim.ts';
import type { ChatSession } from '../../surface/renderer/web/use-chat.ts';
import { HarnessSession } from '../../surface/session.ts';
import { startPageHarness } from '../start.ts';
import { composition } from './composition.ts';

installBufferShim();

/** The A2UI plugin is not part of this build, so the chat offers no catalog: text only. */
const open = async (): Promise<ChatSession> => {
  const harness = await startPageHarness(composition);
  return HarnessSession.connect(harness.ctx.harnessTarget, { a2uiCatalogs: [], longRunning: true });
};

let opened: Promise<ChatSession> | undefined = undefined;

/** One harness per tab, however often the application asks to connect. */
const connect = (): Promise<ChatSession> => {
  opened ??= open();
  return opened;
};

const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App connect={connect} />
    </StrictMode>,
  );
}
