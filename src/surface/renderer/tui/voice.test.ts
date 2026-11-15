import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import { FakeDisplay, renderToText, waitFor } from '../../../../test/support/tui.ts';
import { t } from '../../../kernel/strings.ts';
import type { TurnInput } from '../../session.ts';
import type { TaskView } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';
import type { TuiRecorder, TuiSession } from './controller.ts';
import { TuiController } from './controller.ts';
import type { FocusAt, KeyPress } from './keys.ts';
import { handleKey } from './keys.ts';
import { runPlain } from './plain.ts';
import type { RecorderProcess, StartOutcome } from './recorder.ts';
import { VoiceRecorder, pcmOf, recorderCommands, wavOf } from './recorder.ts';

const NO_KEY: KeyPress = {
  ctrl: false,
  shift: false,
  meta: false,
  tab: false,
  return: false,
  backspace: false,
  delete: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
};

/** A recorder process a test drives by hand. */
class FakeProcess implements RecorderProcess {
  readonly killed: string[] = [];
  readonly #data: ((chunk: Uint8Array) => void)[] = [];
  readonly #events = new Map<string, ((error: Error) => void)[]>();
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: Uint8Array) => void): void => {
      this.#data.push(listener);
    },
  };

  on(event: string, listener: (error: Error) => void): void {
    this.#events.set(event, [...(this.#events.get(event) ?? []), listener]);
  }

  kill(signal?: string): void {
    this.killed.push(signal ?? '');
    this.emit('close');
  }

  emit(event: string, error: Error = new Error('none')): void {
    for (const listener of this.#events.get(event) ?? []) {
      listener(error);
    }
  }

  write(...bytes: number[]): void {
    for (const listener of this.#data) {
      listener(Uint8Array.from(bytes));
    }
  }
}

/** A recorder process that exits only when it is killed outright. */
class StubbornProcess extends FakeProcess {
  override kill(signal?: string): void {
    this.killed.push(signal ?? '');
    if (signal === 'SIGKILL') {
      this.emit('close');
    }
  }
}

/** A recorder over fake processes: every spawn is recorded and starts at once. */
function recorderWith(options: { has?: readonly string[]; fail?: Error; maxBytes?: number } = {}) {
  const spawned: { command: string; args: readonly string[]; process: FakeProcess }[] = [];
  const recorder = new VoiceRecorder({
    platform: 'linux',
    maxBytes: options.maxBytes,
    available: (command) => (options.has ?? ['arecord', 'pw-record', 'ffmpeg']).includes(command),
    spawn: (command, args) => {
      const process = new FakeProcess();
      spawned.push({ command, args, process });
      queueMicrotask(() => {
        process.emit(options.fail === undefined ? 'spawn' : 'error', options.fail);
      });
      return process;
    },
  });
  return { recorder, spawned };
}

describe('voice recorder', () => {
  test('knows three recorders, each started with fixed arguments that write PCM to stdout', () => {
    const linux = recorderCommands('linux');
    expect(linux.map((recorder) => recorder.command)).toEqual(['arecord', 'pw-record', 'ffmpeg']);
    expect(linux.every((recorder) => recorder.args.at(-1) === '-')).toBe(true);
    expect(linux[2]?.args.join(' ')).toContain('-f pulse -i default');
    expect(recorderCommands('darwin')[2]?.args.join(' ')).toContain('-f avfoundation -i :0');
  });

  test('starts the first recorder that exists and returns what it wrote as a WAV file', async () => {
    const { recorder, spawned } = recorderWith({ has: ['pw-record', 'ffmpeg'] });
    expect(recorder.recording).toBe(false);
    expect(await recorder.start()).toEqual({ ok: true });
    expect(recorder.recording).toBe(true);
    expect(spawned.map((entry) => entry.command)).toEqual(['pw-record']);
    expect(spawned[0]?.args).toEqual([
      '--rate',
      '16000',
      '--channels',
      '1',
      '--format',
      's16',
      '-',
    ]);
    spawned[0]?.process.write(1, 0, 2, 0);
    spawned[0]?.process.write(3, 0);
    const file = await recorder.stop();
    expect(spawned[0]?.process.killed).toEqual(['SIGTERM']);
    expect(file?.mediaType).toBe('audio/wav');
    expect(file?.name).toBe('voice-message.wav');
    const bytes = file?.data ?? new Uint8Array(0);
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(6);
    expect([...bytes.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(recorder.recording).toBe(false);
    expect(await recorder.stop()).toBeNull();
  });

  test('says so when no recorder exists, and when one cannot be started', async () => {
    expect(await recorderWith({ has: [] }).recorder.start()).toEqual({
      ok: false,
      reason: 'no-recorder',
    });
    const failing = recorderWith({ fail: new Error('spawn arecord EACCES') });
    expect(await failing.recorder.start()).toEqual({
      ok: false,
      reason: 'spawn-failed',
      message: 'spawn arecord EACCES',
    });
    expect(failing.recorder.recording).toBe(false);
    const throwing = new VoiceRecorder({
      available: () => true,
      spawn: () => {
        throw new Error('no fork');
      },
    });
    expect(await throwing.start()).toEqual({
      ok: false,
      reason: 'spawn-failed',
      message: 'no fork',
    });
  });

  test('keeps no more than its limit, stops the recorder there, and returns null for silence', async () => {
    const { recorder, spawned } = recorderWith({ maxBytes: 4 });
    await recorder.start();
    spawned[0]?.process.write(1, 2, 3);
    spawned[0]?.process.write(4, 5, 6);
    expect(spawned[0]?.process.killed).toEqual([]);
    spawned[0]?.process.write(7);
    expect(spawned[0]?.process.killed).toEqual(['SIGTERM']);
    const file = await recorder.stop();
    expect([...(file?.data.subarray(44) ?? [])]).toEqual([1, 2, 3, 4]);

    const silent = recorderWith();
    await silent.recorder.start();
    expect(await silent.recorder.stop()).toBeNull();
  });

  test('says when it reaches its limit, once', async () => {
    const { recorder, spawned } = recorderWith({ maxBytes: 2 });
    let limits = 0;
    await recorder.start(() => {
      limits += 1;
    });
    spawned[0]?.process.write(1, 2);
    expect(limits).toBe(0);
    spawned[0]?.process.write(3);
    spawned[0]?.process.write(4);
    expect(limits).toBe(1);
    expect(spawned[0]?.process.killed).toEqual(['SIGTERM']);
  });

  test('kills a recorder that does not exit when asked to stop', async () => {
    const stubborn = new StubbornProcess();
    const recorder = new VoiceRecorder({
      available: () => true,
      stopTimeoutMs: 10,
      spawn: () => {
        queueMicrotask(() => {
          stubborn.emit('spawn');
        });
        return stubborn;
      },
    });
    await recorder.start();
    stubborn.write(5, 0);
    const file = await recorder.stop();
    expect(stubborn.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect([...(file?.data.subarray(44) ?? [])]).toEqual([5, 0]);
  });

  test('reads the samples after a WAV header when the recorder wrote one', () => {
    const wav = wavOf(Uint8Array.from([9, 8, 7, 6]));
    expect([...pcmOf(wav)]).toEqual([9, 8, 7, 6]);
    expect([...pcmOf(Uint8Array.from([1, 2, 3]))]).toEqual([1, 2, 3]);
    const headerOnly = new TextEncoder().encode(`RIFF${'x'.repeat(40)}ab`);
    expect([...pcmOf(headerOnly)]).toEqual([97, 98]);
  });

  test('the system recorder finds nothing to start on an empty PATH', async () => {
    const before = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      expect(await new VoiceRecorder().start()).toEqual({ ok: false, reason: 'no-recorder' });
    } finally {
      process.env['PATH'] = before;
    }
  });
});

const VOICE = { mediaType: 'audio/wav', name: 'voice-message.wav', data: Uint8Array.from([1, 2]) };

function fakeSession(): TuiSession & { sent: TurnInput[] } {
  const sent: TurnInput[] = [];
  return {
    sent,
    commands: [],
    dashboardUrl: null,
    // oxlint-disable-next-line typescript/require-await -- an async generator by contract
    send: async function* send(input, view) {
      sent.push(input);
      yield { ...(view ?? EMPTY_VIEW), taskId: 't1', state: 'awaiting-next-interaction' };
    },
    complete: (view) => Promise.resolve({ ...view, state: 'completed' }),
    cancel: (view) => Promise.resolve({ ...view, state: 'canceled' }),
  };
}

const STARTED: StartOutcome = { ok: true };
const INPUT_LINE: FocusAt = { index: 0, cursor: 0 };

/** A recorder the test scripts: how it starts, and what it hands back. */
function fakeRecorder(outcome: StartOutcome = STARTED, file: typeof VOICE | null = VOICE) {
  const calls: string[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder: TuiRecorder & { holdStart: boolean } = {
    holdStart: false,
    start: async () => {
      calls.push('start');
      if (recorder.holdStart) {
        await held;
      }
      return outcome;
    },
    stop: () => {
      calls.push('stop');
      return Promise.resolve(file);
    },
  };
  return { recorder, calls, release };
}

function notes(controller: TuiController): string[] {
  return controller
    .getState()
    .view.items.flatMap((item) => (item.kind === 'note' ? [item.text] : []));
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

describe('terminal UI: voice', () => {
  function keyboard(controller: TuiController, text = '', focus: FocusAt = INPUT_LINE) {
    const state = { text, focus };
    const press = (input: string, key: Partial<KeyPress> = {}): void => {
      const context = {
        controller,
        form: null,
        text: state.text,
        focus: state.focus,
        setText: (next: string) => {
          state.text = next;
        },
        setFocus: (next: FocusAt) => {
          state.focus = next;
        },
      };
      handleKey(context, input, { ...NO_KEY, ...key });
    };
    return { state, press };
  }

  /**
   * Feature: Terminal UI
   * Scenario: Space on an empty input line records, and Space again sends the recording
   *   Given a terminal that does not report key release, and a working recorder
   *   When the user presses Space on an empty input line, and presses it again
   *   Then the first press starts a recording and the screen says so
   *   And the second sends the recording as the user's turn, with no text
   * Requirement: docs/specs/issue-3/requirements.md R24.4
   */
  test('Space on an empty input line records, and Space again sends the recording', async () => {
    const session = fakeSession();
    const { recorder, calls } = fakeRecorder();
    const controller = new TuiController(session, recorder);
    const keys = keyboard(controller);
    keys.press(' ');
    await settle();
    expect(controller.getState().recording).toBe('toggle');
    expect(renderToText(controller.getState().view, { recording: 'toggle' })).toContain(
      t('tui.voice.recording.toggle'),
    );
    // Nothing is typed into a recording.
    keys.press('x');
    expect(keys.state.text).toBe('');
    keys.press(' ');
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    expect(controller.getState().recording).toBe('off');
    expect(session.sent).toEqual([{ text: '', files: [VOICE] }]);
  });

  /**
   * Feature: Terminal UI
   * Scenario: Where the terminal reports key release, holding Space records and releasing sends
   *   Given a terminal that speaks the kitty keyboard protocol
   *   When Space goes down on an empty input line, repeats, and comes up
   *   Then the recording starts on the press, the repeats change nothing, and the release sends it
   *   And the release of any other key does nothing at all
   * Requirement: docs/specs/issue-3/requirements.md R24.4
   */
  test('Where the terminal reports key release, holding Space records and releasing sends', async () => {
    const session = fakeSession();
    const { recorder, calls } = fakeRecorder();
    const controller = new TuiController(session, recorder);
    const keys = keyboard(controller);
    keys.press('a', { eventType: 'press' });
    keys.press('a', { eventType: 'release' });
    expect(keys.state.text).toBe('a');
    keys.state.text = '';
    keys.press(' ', { eventType: 'press' });
    await settle();
    expect(controller.getState().recording).toBe('hold');
    keys.press(' ', { eventType: 'repeat' });
    keys.press(' ', { eventType: 'repeat' });
    expect(calls).toEqual(['start']);
    keys.press(' ', { eventType: 'release' });
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    expect(session.sent.length).toBe(1);
    // A release with nothing recording, and a press while a toggled recording runs.
    keys.press(' ', { eventType: 'release' });
    expect(calls).toEqual(['start', 'stop']);
  });

  test('a release that arrives before the recorder is running still ends the recording', async () => {
    const session = fakeSession();
    const { recorder, calls, release } = fakeRecorder();
    recorder.holdStart = true;
    const controller = new TuiController(session, recorder);
    const keys = keyboard(controller);
    keys.press(' ', { eventType: 'press' });
    keys.press(' ', { eventType: 'press' });
    await settle();
    void controller.stopVoice();
    release();
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    expect(session.sent.length).toBe(1);
  });

  test('Space is ordinary input once something is typed, and on a form control', () => {
    const { recorder, calls } = fakeRecorder();
    const controller = new TuiController(fakeSession(), recorder);
    const typing = keyboard(controller, 'Hello');
    typing.press(' ');
    expect(typing.state.text).toBe('Hello ');
    const elsewhere = keyboard(controller, '', { index: 1, cursor: 0 });
    elsewhere.press(' ');
    elsewhere.press(' ', { ctrl: true });
    expect(calls).toEqual([]);
  });

  test('Escape discards the recording', async () => {
    const session = fakeSession();
    const { recorder, calls } = fakeRecorder();
    const controller = new TuiController(session, recorder);
    const keys = keyboard(controller);
    keys.press(' ');
    await settle();
    keys.press('', { escape: true });
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    expect(session.sent).toEqual([]);
    expect(controller.getState().recording).toBe('off');
  });

  /**
   * Feature: Terminal UI
   * Scenario: Without a recorder the interface says so and typing still works
   *   Given a machine with none of arecord, pw-record and ffmpeg, or one that cannot start
   *   When the user presses the voice key
   *   Then a note says voice input is off and why
   *   And a typed message is sent as before
   * Requirement: docs/specs/issue-3/requirements.md R24.6
   */
  test('Without a recorder the interface says so and typing still works', async () => {
    const session = fakeSession();
    const missing = new TuiController(
      session,
      fakeRecorder({ ok: false, reason: 'no-recorder' }).recorder,
    );
    const keys = keyboard(missing);
    keys.press(' ');
    await settle();
    expect(notes(missing)).toEqual([t('tui.voice.unavailable')]);
    expect(missing.getState().recording).toBe('off');
    for (const letter of 'Hi') {
      keys.press(letter);
    }
    keys.press('', { return: true });
    await settle();
    expect(session.sent).toEqual([{ text: 'Hi' }]);

    const failed: StartOutcome = { ok: false, reason: 'spawn-failed', message: 'EACCES' };
    const broken = new TuiController(fakeSession(), fakeRecorder(failed).recorder);
    await broken.startVoice(false);
    expect(notes(broken)).toEqual([t('tui.voice.failed', { reason: 'EACCES' })]);
  });

  test('the same holds with the real recorder class when no program is on PATH', async () => {
    const session = fakeSession();
    const controller = new TuiController(session, recorderWith({ has: [] }).recorder);
    await controller.startVoice(false);
    expect(notes(controller)).toEqual([t('tui.voice.unavailable')]);
    await controller.submit('Typed instead');
    expect(session.sent).toEqual([{ text: 'Typed instead' }]);
  });

  test('a recording with no sound is said to be empty; leaving stops a recording', async () => {
    const session = fakeSession();
    const empty = fakeRecorder(STARTED, null);
    const controller = new TuiController(session, empty.recorder);
    await controller.startVoice(false);
    await controller.stopVoice();
    expect(notes(controller)).toEqual([t('tui.voice.empty')]);
    expect(session.sent).toEqual([]);
    await controller.stopVoice();

    const running = fakeRecorder();
    const leaving = new TuiController(fakeSession(), running.recorder);
    await leaving.startVoice(true);
    await leaving.startVoice(true);
    leaving.exit();
    expect(running.calls).toEqual(['start', 'stop']);
    await leaving.startVoice(false);
    expect(running.calls).toEqual(['start', 'stop']);
  });

  test('leaving while the recorder is starting stops it once it runs', async () => {
    const starting = fakeRecorder();
    starting.recorder.holdStart = true;
    const controller = new TuiController(fakeSession(), starting.recorder);
    const started = controller.startVoice(false);
    controller.exit();
    starting.release();
    await started;
    expect(starting.calls).toEqual(['start', 'stop']);
  });

  test('a recording that reaches its limit ends itself and is sent', async () => {
    const session = fakeSession();
    const { recorder, spawned } = recorderWith({ maxBytes: 2 });
    const controller = new TuiController(session, recorder);
    await controller.startVoice(false);
    expect(controller.getState().recording).toBe('toggle');
    spawned[0]?.process.write(1, 0);
    spawned[0]?.process.write(2, 0);
    await settle();
    expect(controller.getState().recording).toBe('off');
    expect(session.sent).toHaveLength(1);
    expect([...(session.sent[0]?.files?.[0]?.data.subarray(44) ?? [])]).toEqual([1, 0]);
  });

  test('the key hints offer the voice key, and the input line says how a held recording ends', () => {
    const idle = renderToText(EMPTY_VIEW);
    expect(idle).toContain(t('tui.hint.voice'));
    expect(renderToText(EMPTY_VIEW, { busy: true })).not.toContain(t('tui.hint.voice'));
    expect(renderToText(EMPTY_VIEW, { recording: 'hold' })).toContain(
      t('tui.voice.recording.hold'),
    );
  });
});

describe('terminal UI: files', () => {
  const view: TaskView = {
    ...EMPTY_VIEW,
    taskId: 't1',
    state: 'awaiting-next-interaction',
    items: [
      { kind: 'file', id: 'm1/0', from: 'user', mediaType: 'audio/wav', name: '', url: null },
      {
        kind: 'file',
        id: 'artifact-1/0',
        from: 'agent',
        mediaType: 'image/png',
        name: 'lamp\u001B[2J.png',
        url: 'https://img.example/lamp.png\u0007',
      },
    ],
  };

  test('a file is a label, its name and where it is — with terminal control removed', () => {
    const drawn = renderToText(view);
    expect(drawn).toContain('[Voice message] — kept with the task as m1/0');
    expect(drawn).toContain('[Image] lamp.png — at https://img.example/lamp.png');
    expect(drawn.includes('\u0007')).toBe(false);
  });

  test('plain mode prints a file as one line', async () => {
    const session: TuiSession = {
      ...fakeSession(),
      // oxlint-disable-next-line typescript/require-await -- an async generator by contract
      send: async function* send() {
        yield view;
      },
    };
    const controller = new TuiController(session, fakeRecorder().recorder);
    const input = new PassThrough();
    const output = new FakeDisplay(false);
    const done = runPlain(controller, input, output);
    input.write('show me\n');
    await waitFor(
      () => output.text.includes('lamp.png'),
      () => output.text,
    );
    input.end();
    await done;
    expect(output.text).toContain('you: [Voice message] — kept with the task as m1/0');
    expect(output.text).toContain('agent: [Image] lamp.png — at https://img.example/lamp.png');
  });
});
