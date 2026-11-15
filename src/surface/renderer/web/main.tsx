/**
 * The browser entry point. The harness serves this page from its own origin, so the
 * session connects to wherever the page came from.
 */
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is the import's whole purpose
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HarnessSession } from '../../session.ts';
import { App } from './app.tsx';
import { BASIC_CATALOG_ID } from './index.ts';
import { installBufferShim } from './lib/buffer-shim.ts';
import type { ChatSession } from './use-chat.ts';

installBufferShim();

const connect = (): Promise<ChatSession> =>
  HarnessSession.connect(window.location.origin, {
    a2uiCatalogs: [BASIC_CATALOG_ID],
    longRunning: true,
  });

const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App connect={connect} />
    </StrictMode>,
  );
}
