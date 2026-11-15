import { describe, expect, test } from 'bun:test';

import type { ChatSession, SpeechPlayer } from '../../../../test/web/index.ts';
import {
  ChatScreen,
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
  webTest,
  useVoiceInput,
} from '../../../../test/web/index.ts';
import { t } from '../../../kernel/strings.ts';
import type { TurnFile, TurnInput } from '../../session.ts';
import type { TaskView } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';
import type { Recording } from './lib/recorder.ts';
import { MAX_RECORDING_MS } from './use-voice.ts';

webTest();

/** A session that answers every turn at once, and says whether it has a voice. */
function session(output: boolean | null): ChatSession & { readonly sent: TurnInput[] } {
  const sent: TurnInput[] = [];
  return {
    sent,
    commands: [],
    dashboardUrl: null,
    ...(output === null ? {} : { voice: { transcription: true, output } }),
    async *send(input: TurnInput, view: TaskView = EMPTY_VIEW): AsyncIterable<TaskView> {
      sent.push(input);
      await Promise.resolve();
      yield { ...view, taskId: 't1', state: 'awaiting-next-interaction' };
    },
    complete: (view: TaskView): Promise<TaskView> => Promise.resolve(view),
    cancel: (view: TaskView): Promise<TaskView> => Promise.resolve(view),
  };
}

/** A player that records what the chat asks of it and can be told it is speaking. */
function player(): SpeechPlayer & { readonly calls: string[]; speak(speaking: boolean): void } {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let state = { speaking: false, chunks: 0 };
  return {
    calls,
    enable: () => {
      calls.push('enable');
    },
    stop: () => {
      calls.push('stop');
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    speak: (speaking) => {
      state = { speaking, chunks: state.chunks + 1 };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function say(container: HTMLElement, text: string): void {
  const field = container.querySelector('textarea');
  if (field === null) {
    throw new Error('The chat has no input.');
  }
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

describe('spoken answers in the chat', () => {
  /**
   * Feature: Web renderer
   * Scenario: The voice-output switch asks for spoken answers and plays them
   *   Given a harness that offers spoken answers, and the chat with the switch off
   *   When the user sends a message, turns the switch on, and sends another
   *   Then the first turn does not ask for speech and the second does
   *   And turning the switch on opened the audio output, from the user's own click
   *   And while audio plays the page says so, and turning the switch off stops it
   * Requirement: docs/specs/issue-3/requirements.md R24.5
   */
  test('The voice-output switch asks for spoken answers and plays them', async () => {
    const harness = session(true);
    const audio = player();
    const { container } = render(<ChatScreen session={harness} player={audio} />);
    const toggle = (): Element | null => container.querySelector('[data-slot="speak-toggle"]');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    say(container, 'Quietly');
    await waitFor(() => {
      expect(harness.sent.length).toBe(1);
    });
    await waitFor(() => {
      expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    });
    fireEvent.click(toggle() ?? container);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(audio.calls).toEqual(['enable']);
    say(container, 'Aloud');
    await waitFor(() => {
      expect(harness.sent.length).toBe(2);
    });
    expect(harness.sent.map((turn) => turn.speak)).toEqual([false, true]);

    expect(container.querySelector('[data-slot="speaking"]')).toBeNull();
    act(() => {
      audio.speak(true);
    });
    expect(container.querySelector('[data-slot="speaking"]')?.textContent).toBe(
      t('web.speak.playing'),
    );
    fireEvent.click(toggle() ?? container);
    expect(audio.calls).toEqual(['enable', 'stop']);
    act(() => {
      audio.speak(false);
    });
    expect(container.querySelector('[data-slot="speaking"]')).toBeNull();
  });

  test('the switch is not offered when the harness has no voice, and the chat is silent', async () => {
    for (const output of [false, null]) {
      const harness = session(output);
      const { container, unmount } = render(<ChatScreen session={harness} />);
      expect(container.querySelector('[data-slot="speak-toggle"]')).toBeNull();
      say(container, 'Hello');
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await waitFor(() => {
        expect(harness.sent.length).toBe(1);
      });
      expect(harness.sent[0]?.speak).toBe(false);
      unmount();
    }
  });
});

describe('useVoiceInput', () => {
  const FILE: TurnFile = { mediaType: 'audio/webm', name: 'v.webm', data: Uint8Array.from([1]) };

  test('a recording left running is ended and sent after the longest time allowed', async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const recorded: TurnFile[] = [];
    const start = (): Promise<Recording> =>
      Promise.resolve({ stop: () => Promise.resolve(FILE), cancel: () => undefined });
    const { result } = renderHook(() =>
      useVoiceInput((file) => {
        recorded.push(file);
      }, start),
    );
    Object.assign(globalThis, {
      setTimeout: (run: () => void, ms: number) => {
        timers.push({ run, ms });
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    try {
      await act(async () => {
        result.current.toggle();
        // A second press before the microphone has opened is ignored.
        result.current.toggle();
        await Promise.resolve();
      });
    } finally {
      Object.assign(globalThis, { setTimeout: realSet, clearTimeout: realClear });
    }
    expect(result.current.recording).toBe(true);
    const limit = timers.find((timer) => timer.ms === MAX_RECORDING_MS);
    expect(limit === undefined).toBe(false);
    await act(async () => {
      limit?.run();
      await Promise.resolve();
    });
    expect(result.current.recording).toBe(false);
    expect(recorded).toEqual([FILE]);
  });
});
