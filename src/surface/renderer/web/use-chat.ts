/**
 * The state of the chat screen: one task's view, driven through a session. The hook owns
 * no protocol knowledge — it calls the session and shows the views it yields.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { CommandInfo } from '../../../app/api-server/extensions/index.ts';
import { t } from '../../../kernel/strings.ts';
import type { Followable } from '../../attach.ts';
import { attach } from '../../attach.ts';
import type { TurnFile, TurnInput, VoiceSupport } from '../../session.ts';
import type { TaskView } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';
import type { ActionMessage } from './a2ui/stage.ts';

/** The part of `HarnessSession` the chat uses; a test can stand in for it. */
export interface ChatSession {
  readonly commands: readonly CommandInfo[];
  readonly dashboardUrl: string | null;
  /** What the harness can do with voice; absent means nothing. */
  readonly voice?: VoiceSupport | undefined;
  send(input: TurnInput, view?: TaskView): AsyncIterable<TaskView>;
  complete(view: TaskView): Promise<TaskView>;
  cancel(view: TaskView): Promise<TaskView>;
  /** With both, the chat adopts a task open on the harness and follows other surfaces. */
  openTasks?: Followable['openTasks'] | undefined;
  follow?: Followable['follow'] | undefined;
  /** Take up the task that is already open on the harness (the page was opened with `?attach`). */
  adopt?: boolean | undefined;
}

/** What the chat screen draws and can do. */
export interface Chat {
  readonly view: TaskView;
  /** True while a turn is in flight. */
  readonly busy: boolean;
  /** Why the last request did not complete, in words, or null. */
  readonly error: string | null;
  readonly send: (text: string, files?: readonly TurnFile[]) => void;
  /** Spoken answers: on or off, or null when the harness does not offer them. */
  readonly speak: { readonly on: boolean; readonly onToggle: () => void } | null;
  /** True while a spoken answer is playing. */
  readonly speaking: boolean;
  /** Sends a user's action on an A2UI surface. */
  readonly act: (message: ActionMessage) => void;
  readonly complete: () => void;
  readonly cancel: () => void;
}

function failure(error: unknown): string {
  return t('web.error.turn', { reason: error instanceof Error ? error.message : String(error) });
}

/**
 * A turn that ended while the view still says "working" produced no task status: a
 * command's reply. The task is where it was before the turn.
 */
function settle(after: TaskView, before: TaskView): TaskView {
  return after.state === 'working' ? { ...after, state: before.state } : after;
}

/** The view on screen, readable at any moment by a request that is still running. */
interface Shown {
  readonly view: TaskView;
  readonly latest: () => TaskView;
  readonly show: (next: TaskView) => void;
  /** Records that the user canceled `taskId`: a turn still streaming cannot reopen it. */
  readonly close: (taskId: string | null) => void;
}

function useShown(): Shown {
  const [view, setView] = useState<TaskView>(EMPTY_VIEW);
  const current = useRef<TaskView>(EMPTY_VIEW);
  const canceled = useRef<string | null>(null);
  const show = useCallback((next: TaskView): void => {
    const closed = next.taskId !== null && next.taskId === canceled.current;
    current.current = closed ? { ...next, state: 'canceled' } : next;
    setView(current.current);
  }, []);
  const latest = useCallback((): TaskView => current.current, []);
  const close = useCallback((taskId: string | null): void => {
    canceled.current = taskId;
  }, []);
  return { view, latest, show, close };
}

/** Runs one request at a time, and keeps why the last one failed. */
interface Runner {
  /** The same as `busy`, readable at any moment. */
  readonly running: () => boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly fail: (error: unknown) => void;
  readonly run: (work: (before: TaskView) => Promise<void>) => void;
}

function useRunner({ latest, show }: Shown): Runner {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const fail = useCallback((error_: unknown): void => {
    setError(failure(error_));
  }, []);
  const run = useCallback(
    (work: (before: TaskView) => Promise<void>): void => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      setBusy(true);
      setError(null);
      const before = latest();
      const attempt = async (): Promise<void> => {
        try {
          await work(before);
        } catch (error_) {
          // A turn cut short by the user's own cancel is not a failure to report.
          if (latest().state !== 'canceled') {
            fail(error_);
          }
        }
        show(settle(latest(), before));
        inFlight.current = false;
        setBusy(false);
      };
      void attempt();
    },
    [fail, latest, show],
  );
  const running = useCallback((): boolean => inFlight.current, []);
  return { busy, error, fail, run, running };
}

/** What plays a spoken answer; the chat only turns it on and off. */
export interface SpeechPlayer {
  readonly enable: () => void;
  readonly stop: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => { readonly speaking: boolean; readonly chunks: number };
}

const SILENT: SpeechPlayer = {
  enable: () => undefined,
  stop: () => undefined,
  subscribe: () => () => undefined,
  getState: () => NOT_SPEAKING,
};
const NOT_SPEAKING = { speaking: false, chunks: 0 };

/** Whether answers are spoken, and the switch that changes it. */
function useSpeak(
  session: ChatSession,
  player: SpeechPlayer,
): { on: boolean; speaking: boolean; control: Chat['speak'] } {
  const [on, setOn] = useState(false);
  const { speaking } = useSyncExternalStore(player.subscribe, player.getState);
  const latest = useRef(false);
  const onToggle = useCallback((): void => {
    latest.current = !latest.current;
    // Turning it on is the user's gesture that lets the page make sound.
    if (latest.current) {
      player.enable();
    } else {
      player.stop();
    }
    setOn(latest.current);
  }, [player]);
  const offered = session.voice?.output === true;
  return { on: on && offered, speaking, control: offered ? { on, onToggle } : null };
}

/** Adopts a task open on the harness and follows what other surfaces do on it. */
function useAttach(session: ChatSession, { latest, show }: Shown, running: () => boolean): void {
  useEffect(() => {
    const { openTasks, follow } = session;
    if (openTasks === undefined || follow === undefined) {
      return undefined;
    }
    return attach(
      {
        openTasks: () => openTasks.call(session),
        follow: (id, signal) => follow.call(session, id, signal),
      },
      { current: latest, busy: running, show, adopt: session.adopt === true },
    );
  }, [latest, running, session, show]);
}

/** Drives one conversation through `session`. */
export function useChat(session: ChatSession, player: SpeechPlayer = SILENT): Chat {
  const speak = useSpeak(session, player);
  const shown = useShown();
  const { view, latest, show, close } = shown;
  const { busy, error, fail, run, running } = useRunner(shown);
  useAttach(session, shown, running);

  const turn = useCallback(
    (input: TurnInput): void => {
      run(async (before) => {
        for await (const next of session.send(input, before)) {
          show(next);
        }
      });
    },
    [run, session, show],
  );
  const send = useCallback(
    (text: string, files: readonly TurnFile[] = []): void => {
      turn({ text, files, speak: speak.on });
    },
    [speak.on, turn],
  );
  const act = useCallback(
    (message: ActionMessage): void => {
      turn({ text: '', a2uiAction: message });
    },
    [turn],
  );
  const complete = useCallback((): void => {
    run(async (before) => {
      show(await session.complete(before));
    });
  }, [run, session, show]);
  /** Cancelling interrupts a turn in flight, so it does not wait for one. */
  const cancel = useCallback((): void => {
    const request = async (): Promise<void> => {
      try {
        const canceled = await session.cancel(latest());
        if (canceled.state === 'canceled') {
          close(canceled.taskId);
        }
        show({ ...latest(), state: canceled.state });
      } catch (error_) {
        fail(error_);
      }
    };
    void request();
  }, [close, fail, latest, session, show]);

  return {
    view,
    busy,
    error,
    send,
    act,
    complete,
    cancel,
    speak: speak.control,
    speaking: speak.speaking,
  };
}
