import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { t } from '../../../kernel/strings.ts';
import { ChatScreen } from './chat.tsx';
import type { ChatSession } from './use-chat.ts';

/** Props of {@link App}. */
export interface AppProps {
  /** Opens the session with the harness that serves this page. */
  readonly connect: () => Promise<ChatSession>;
}

type Connection =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly session: ChatSession }
  | { readonly status: 'failed'; readonly reason: string };

/** The application: connects once, then shows the chat — or says why it cannot. */
export function App({ connect }: AppProps): ReactNode {
  const [connection, setConnection] = useState<Connection>({ status: 'connecting' });
  useEffect(() => {
    let current = true;
    const open = async (): Promise<Connection> => {
      try {
        return { status: 'ready', session: await connect() };
      } catch (error) {
        return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
    };
    const start = async (): Promise<void> => {
      const opened = await open();
      if (current) {
        setConnection(opened);
      }
    };
    void start();
    return (): void => {
      current = false;
    };
  }, [connect]);
  if (connection.status === 'ready') {
    return <ChatScreen session={connection.session} />;
  }
  return (
    <main className="grid h-dvh place-items-center p-6 text-center text-sm text-muted-foreground">
      {connection.status === 'connecting' ? (
        <p role="status">{t('web.connecting')}</p>
      ) : (
        <p role="alert" className="text-destructive">
          {t('web.error.connect', { reason: connection.reason })}
        </p>
      )}
    </main>
  );
}
