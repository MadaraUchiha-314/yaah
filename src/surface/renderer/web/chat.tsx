import type { ReactNode } from 'react';

import { Composer } from './components/composer.tsx';
import { TaskHeader } from './components/task-header.tsx';
import { Transcript } from './components/transcript.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import type { ChatSession } from './use-chat.ts';
import { useChat } from './use-chat.ts';

/** The chat screen: the task's header, the conversation, and the composer pinned below. */
export function ChatScreen({ session }: { readonly session: ChatSession }): ReactNode {
  const chat = useChat(session);
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
          <Composer
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
