/**
 * The microphone button's state: not recording, recording, or unable to — and why. A
 * failure is kept as a problem to show; it never throws, and never touches text input.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { TurnFile } from '../../session.ts';
import type { MicProblem, Recording } from './lib/recorder.ts';
import { MicError, recordFromBrowser } from './lib/recorder.ts';

/** Starts a recording; the browser's, unless a test passes its own. */
export type StartRecording = () => Promise<Recording>;

/** What the microphone button shows and does. */
export interface VoiceInput {
  readonly recording: boolean;
  /** Why the last attempt to record did not work, or null. */
  readonly problem: MicProblem | null;
  /** Starts recording, or ends it and hands the recording over. */
  readonly toggle: () => void;
}

/** A recording is ended on its own after this long. */
export const MAX_RECORDING_MS = 120_000;

function problemOf(error: unknown): MicProblem {
  return error instanceof MicError ? error.problem : 'failed';
}

/**
 * Drives one microphone button.
 *
 * @param onRecorded Receives each finished recording.
 */
export function useVoiceInput(
  onRecorded: (file: TurnFile) => void,
  start: StartRecording = recordFromBrowser,
): VoiceInput {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const current = useRef<Recording | null>(null);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback(async (): Promise<void> => {
    const active = current.current;
    current.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setRecording(false);
    if (active === null) {
      return;
    }
    try {
      onRecorded(await active.stop());
    } catch (error) {
      setProblem(problemOf(error));
    }
  }, [onRecorded]);

  const begin = useCallback(async (): Promise<void> => {
    pending.current = true;
    setProblem(null);
    try {
      current.current = await start();
      setRecording(true);
      timer.current = setTimeout(() => {
        void finish();
      }, MAX_RECORDING_MS);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      pending.current = false;
    }
  }, [finish, start]);

  const toggle = useCallback((): void => {
    if (pending.current) {
      return;
    }
    void (current.current === null ? begin() : finish());
  }, [begin, finish]);

  useEffect(
    () => (): void => {
      current.current?.cancel();
      current.current = null;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return { recording, problem, toggle };
}
