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
import { PcmPlayer } from './lib/pcm-player.ts';
import type { ChatSession } from './use-chat.ts';

installBufferShim();

const player = new PcmPlayer();

const connect = async (): Promise<ChatSession> => {
  const session = await HarnessSession.connect(window.location.origin, {
    a2uiCatalogs: [BASIC_CATALOG_ID],
    longRunning: true,
    onSpeech: player.play,
  });
  return {
    commands: session.commands,
    dashboardUrl: session.dashboardUrl,
    voice: session.voice,
    send: (input, view) => session.send(input, view),
    complete: (view) => session.complete(view),
    cancel: (view) => session.cancel(view),
    openTasks: () => session.openTasks(),
    follow: (taskId, signal) => session.follow(taskId, signal),
    // `/?attach` takes up the task that is already open on the harness.
    adopt: new URLSearchParams(window.location.search).has('attach'),
  };
};

const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App connect={connect} player={player} />
    </StrictMode>,
  );
}
