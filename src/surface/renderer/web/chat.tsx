import type { ReactNode } from 'react';

import { t } from '../../../kernel/strings.ts';
import { Composer } from './components/composer.tsx';
import { TaskHeader } from './components/task-header.tsx';
import { Transcript } from './components/transcript.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import type { ChatSession, SpeechPlayer } from './use-chat.ts';
import { useChat } from './use-chat.ts';

/** The chat screen: the task's header, the conversation, and the composer pinned below. */
export function ChatScreen({
  session,
  player,
}: {
  readonly session: ChatSession;
  /** Plays spoken answers; without one the chat is silent. */
  readonly player?: SpeechPlayer | undefined;
}): ReactNode {
  const chat = useChat(session, player);
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <TaskHeader
          view={chat.view}
          dashboardUrl={session.dashboardUrl}
          busy={chat.busy}
          onComplete={chat.complete}
          onCancel={chat.cancel}
        />
        <main className="min-h-0 flex-1">
          <Transcript view={chat.view} commands={session.commands} onAction={chat.act} />
        </main>
        <footer className="border-t px-4 pt-3 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          {chat.error !== null && (
            <p role="alert" className="mx-auto mb-2 w-full max-w-3xl px-2 text-sm text-destructive">
              {chat.error}
            </p>
          )}
          {chat.speaking && (
            <p
              role="status"
              data-slot="speaking"
              className="mx-auto mb-2 w-full max-w-3xl px-2 text-xs text-muted-foreground"
            >
              {t('web.speak.playing')}
            </p>
          )}
          <Composer
            speak={chat.speak ?? undefined}
            state={chat.view.state}
            commands={session.commands}
            busy={chat.busy}
            onSend={chat.send}
          />
        </footer>
      </div>
    </TooltipProvider>
  );
}
