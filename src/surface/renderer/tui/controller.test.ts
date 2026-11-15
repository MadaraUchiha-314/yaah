import { describe, expect, test } from 'bun:test';

import { t } from '../../../kernel/strings.ts';
import { refundForm } from '../../../../test/support/a2ui-form.ts';
import type { TaskView, TranscriptItem } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';
import { controlsOf } from './a2ui-tree.ts';
import type { TuiSession } from './controller.ts';
import { TuiController } from './controller.ts';
import type { FocusAt, KeyContext, KeyPress } from './keys.ts';
import { activeForm, handleKey } from './keys.ts';

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

const open = (items: readonly TranscriptItem[] = []): TaskView => ({
  ...EMPTY_VIEW,
  taskId: 't1',
  contextId: 'c1',
  state: 'awaiting-next-interaction',
  items,
});

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      release();
    },
  };
}

/** A session whose answers the test decides. */
function fakeSession(overrides: Partial<TuiSession> = {}): TuiSession & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    commands: [{ name: 'model', description: '', scope: 'harness' }],
    dashboardUrl: null,
    // oxlint-disable-next-line typescript/require-await -- an async generator by contract
    send: async function* send(input, view) {
      sent.push(input);
      yield { ...open((view ?? EMPTY_VIEW).items), state: 'working' };
      yield open([
        ...(view ?? EMPTY_VIEW).items,
        { kind: 'user', id: `u${String(sent.length)}`, text: input.text },
      ]);
    },
    complete: (view) => Promise.resolve({ ...view, state: 'completed' }),
    cancel: (view) => Promise.resolve({ ...view, state: 'canceled' }),
    ...overrides,
  };
}

describe('terminal UI controller', () => {
  test('sends a line, tells its listeners, and ignores empty lines', async () => {
    const session = fakeSession();
    const controller = new TuiController(session);
    const states: string[] = [];
    const stop = controller.subscribe(() => {
      states.push(`${controller.getState().view.state}/${String(controller.getState().busy)}`);
    });
    await controller.submit('   ');
    expect(states).toEqual([]);
    await controller.submit(' hello ');
    expect(session.sent).toEqual([{ text: 'hello' }]);
    expect(states).toEqual([
      'idle/true',
      'working/true',
      'awaiting-next-interaction/true',
      'awaiting-next-interaction/false',
    ]);
    stop();
    await controller.submit('again');
    expect(states.length).toBe(4);
  });

  test('a failure talking to the harness becomes a note and the interface stays usable', async () => {
    const controller = new TuiController(
      fakeSession({
        // oxlint-disable-next-line require-yield, typescript/require-await -- fails at once
        send: async function* send() {
          throw new Error('connection refused');
        },
        complete: () => Promise.reject(new Error('gone')),
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- not every failure is an Error
        cancel: () => Promise.reject('plain reason'),
      }),
    );
    await controller.submit('hello');
    const state = controller.getState();
    expect(state.busy).toBe(false);
    expect(state.view.state).toBe('idle');
    expect(state.view.items.at(-1)).toMatchObject({
      kind: 'note',
      text: t('tui.error', { message: 'connection refused' }),
    });
  });

  test('completing or cancelling does nothing without an open task, and reports a failure', async () => {
    const failing = {
      complete: (): Promise<TaskView> => Promise.reject(new Error('gone')),
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- not every failure is an Error
      cancel: (): Promise<TaskView> => Promise.reject('plain reason'),
    };
    const controller = new TuiController(fakeSession(failing));
    await controller.complete();
    await controller.cancel();
    expect(controller.getState().view.items).toEqual([]);
    await controller.submit('open a task');
    await controller.complete();
    await controller.cancel();
    const notes = controller.getState().view.items.filter((item) => item.kind === 'note');
    expect(notes.map((note) => note.text)).toEqual([
      t('tui.error', { message: 'gone' }),
      t('tui.error', { message: 'plain reason' }),
    ]);
    expect(controller.getState().view.state).toBe('awaiting-next-interaction');
    expect(controller.getState().busy).toBe(false);
  });

  test('a cancellation in the middle of a turn wins over what the turn still streams', async () => {
    const started = gate();
    const resume = gate();
    const controller = new TuiController(
      fakeSession({
        send: async function* send(_input, view) {
          yield { ...open((view ?? EMPTY_VIEW).items), state: 'working' };
          started.release();
          await resume.promise;
          yield open([{ kind: 'agent', id: 'late', text: 'late', streaming: false, a2ui: [] }]);
        },
      }),
    );
    const turn = controller.submit('long job');
    await started.promise;
    await controller.complete();
    expect(controller.getState().view.state).toBe('working');
    await controller.submit('ignored while busy');
    await controller.cancel();
    expect(controller.getState()).toMatchObject({ busy: false, view: { state: 'canceled' } });
    resume.release();
    await turn;
    expect(controller.getState()).toMatchObject({ busy: false, view: { state: 'canceled' } });
    expect(controller.getState().view.items.some((item) => item.id === 'late')).toBe(false);
  });

  test('a cancellation in the middle of an answer leaves the part shown no longer streaming', async () => {
    const started = gate();
    const resume = gate();
    const partial: TranscriptItem = {
      kind: 'agent',
      id: 'response-k1',
      text: 'Half an',
      streaming: true,
      a2ui: [],
    };
    const controller = new TuiController(
      fakeSession({
        send: async function* send() {
          yield { ...open([partial]), state: 'working' };
          started.release();
          await resume.promise;
        },
      }),
    );
    const turn = controller.submit('long answer');
    await started.promise;
    await controller.cancel();
    resume.release();
    await turn;
    expect(controller.getState().view.state).toBe('canceled');
    expect(controller.getState().view.items).toEqual([{ ...partial, streaming: false }]);
  });

  test('a cancellation that fails leaves the turn running and busy', async () => {
    const started = gate();
    const resume = gate();
    const controller = new TuiController(
      fakeSession({
        send: async function* send() {
          yield { ...open(), state: 'working' };
          started.release();
          await resume.promise;
          yield open([{ kind: 'agent', id: 'a', text: 'done', streaming: false, a2ui: [] }]);
        },
        cancel: () => Promise.reject(new Error('not cancelable')),
      }),
    );
    const turn = controller.submit('job');
    await started.promise;
    await controller.cancel();
    expect(controller.getState().busy).toBe(true);
    resume.release();
    await turn;
    expect(controller.getState().busy).toBe(false);
    expect(controller.getState().view.items.map((item) => item.id)).toEqual(['a']);
  });

  test('shows the Temporal address of the task, else of the harness, else says there is none', () => {
    const none = new TuiController(fakeSession());
    none.showTemporal();
    expect(none.getState().view.items.at(-1)).toMatchObject({ text: t('tui.temporal.none') });
    const dashboard = new TuiController(fakeSession({ dashboardUrl: 'http://temporal:8233' }));
    dashboard.showTemporal();
    expect(dashboard.temporalUrl).toBe('http://temporal:8233');
    expect(dashboard.getState().view.items.at(-1)).toMatchObject({
      kind: 'note',
      text: t('tui.status.temporal', { url: 'http://temporal:8233' }),
    });
  });

  test('/exit leaves; afterwards nothing changes and nothing is sent', async () => {
    const session = fakeSession();
    const controller = new TuiController(session);
    controller.model('a', refundForm());
    await controller.submit('/exit');
    expect(controller.getState().exited).toBe(true);
    controller.exit();
    controller.note('late');
    await controller.submit('late');
    await controller.act({
      name: 'x',
      surfaceId: 's',
      sourceComponentId: 'c',
      timestamp: '',
      context: {},
    });
    expect(session.sent).toEqual([]);
    expect(controller.getState().view.items).toEqual([]);
  });
});

describe('terminal UI keys', () => {
  function setup(
    view: TaskView = open([
      { kind: 'agent', id: 'a', text: '', streaming: false, a2ui: refundForm() },
    ]),
  ) {
    const session = fakeSession({
      // oxlint-disable-next-line typescript/require-await -- an async generator by contract
      send: async function* send(input) {
        session.sent.push(input);
        yield view;
      },
    });
    const controller = new TuiController(session);
    const local = { text: '', focus: { index: 0, cursor: 0 } as FocusAt };
    const press = (input: string, key: Partial<KeyPress> = {}): void => {
      const context: KeyContext = {
        controller,
        form: activeForm(controller, view),
        text: local.text,
        focus: local.focus,
        setText: (text) => {
          local.text = text;
        },
        setFocus: (focus) => {
          local.focus = focus;
        },
      };
      handleKey(context, input, { ...NO_KEY, ...key });
    };
    const control = (id: string) =>
      controlsOf(controller.model('a', refundForm()).surfaces()[0]?.root ?? null).find(
        (entry) => entry.id === id,
      );
    return { session, controller, local, press, control };
  }
  const TAB = { tab: true };

  test('Tab and Shift+Tab walk the input line and the controls, and wrap around', () => {
    const { local, press } = setup();
    press('', { tab: true, shift: true });
    expect(local.focus.index).toBe(8);
    press('', TAB);
    expect(local.focus.index).toBe(0);
    press('', TAB);
    expect(local.focus.index).toBe(1);
  });

  test('a slider moves by its step and stays inside its range', () => {
    const { press, control } = setup();
    for (let stop = 0; stop < 4; stop += 1) {
      press('', TAB);
    }
    press('', { rightArrow: true });
    expect(control('amount')).toMatchObject({ value: 25 });
    for (let times = 0; times < 30; times += 1) {
      press('', { leftArrow: true });
    }
    expect(control('amount')).toMatchObject({ value: 0 });
    press('x');
    expect(control('amount')).toMatchObject({ value: 0 });
  });

  test('a text field takes typing, spaces and backspace; Enter leaves it unchanged', () => {
    const { press, control } = setup();
    for (let stop = 0; stop < 3; stop += 1) {
      press('', TAB);
    }
    press('box');
    press(' ');
    press('crushed');
    press('', { backspace: true });
    press('\r', { return: true });
    expect(control('notes')).toMatchObject({ value: 'box crushe' });
  });

  test('a choice keeps its cursor inside the options; a multiple choice toggles', () => {
    const view = open([
      {
        kind: 'agent',
        id: 'a',
        text: '',
        streaming: false,
        a2ui: [
          ...refundForm(),
          [
            {
              version: '1.0',
              updateComponents: {
                surfaceId: 'main',
                components: [
                  {
                    id: 'reason',
                    component: 'ChoicePicker',
                    variant: 'multipleSelection',
                    options: [
                      { label: 'A', value: 'a' },
                      { label: 'B', value: 'b' },
                    ],
                    value: { '@path': '/reason' },
                  },
                ],
              },
            },
          ],
        ],
      },
    ]);
    const { controller, local, press } = setup(view);
    const selected = (): unknown => {
      const item = view.items[0];
      const batches = item?.kind === 'agent' ? item.a2ui : [];
      const [reason] = controlsOf(controller.model('a', batches).surfaces()[0]?.root ?? null);
      return reason?.kind === 'choice' ? reason.selected : null;
    };
    press('', TAB);
    press('', { upArrow: true });
    expect(local.focus.cursor).toBe(0);
    press('', { downArrow: true });
    press('', { downArrow: true });
    expect(local.focus.cursor).toBe(1);
    press(' ');
    expect(selected()).toEqual(['damaged', 'b']);
    press('\r', { return: true });
    expect(selected()).toEqual(['damaged']);
    press('z');
    expect(selected()).toEqual(['damaged']);
  });

  test('a button sends its action and gives the focus back to the input line', async () => {
    const { session, controller, local, press } = setup();
    for (let stop = 0; stop < 7; stop += 1) {
      press('', TAB);
    }
    press('x');
    expect(local.focus.index).toBe(7);
    press(' ');
    expect(local.focus.index).toBe(0);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(session.sent).toMatchObject([
      {
        text: '',
        a2uiAction: { version: '1.0', action: { name: 'skip', sourceComponentId: 'skip' } },
      },
    ]);
    expect(controller.getState().busy).toBe(false);
  });

  test('pasted text with a line end is sent; control keys never type', async () => {
    const { session, local, press } = setup(open());
    press('hello\rignored');
    expect(local.text).toBe('');
    press('q', { ctrl: true });
    press('m', { meta: true });
    press('', { delete: true });
    press('\r', { return: true });
    expect(local.text).toBe('');
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(session.sent).toEqual([{ text: 'hello' }]);
  });

  test('a form in a closed task, or in an older answer, takes no keys', () => {
    const form = {
      kind: 'agent',
      id: 'a',
      text: '',
      streaming: false,
      a2ui: refundForm(),
    } as const;
    const controller = new TuiController(fakeSession());
    expect(activeForm(controller, { ...open([form]), state: 'completed' })).toBeNull();
    expect(activeForm(controller, open([form, { kind: 'user', id: 'u', text: 'x' }]))).toBeNull();
    expect(activeForm(controller, open())).toBeNull();
    expect(activeForm(controller, open([form]))?.entries.length).toBe(8);
  });
});
