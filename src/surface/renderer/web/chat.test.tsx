import { describe, expect, test } from 'bun:test';

import type { ChatSession } from '../../../../test/web/index.ts';
import {
  App,
  ChatScreen,
  act,
  fireEvent,
  render,
  waitFor,
  webTest,
} from '../../../../test/web/index.ts';
import { t } from '../../../kernel/strings.ts';
import { sampleSurface } from '../../../testing/renderer-contract.ts';
import type { TurnInput } from '../../session.ts';
import type { TaskView, TranscriptItem, ViewState } from '../../view.ts';
import { EMPTY_VIEW, isOpen, withUserMessage } from '../../view.ts';

webTest();

/** A gate a test opens to let a scripted turn go on. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: resolve };
}

interface Script {
  /** What the agent says to an ordinary message. */
  readonly answer?: TranscriptItem;
  /** Held until opened, between "working" and the answer. */
  readonly hold?: Promise<void>;
  /** Thrown in place of the answer. */
  readonly failWith?: unknown;
  readonly cancelFails?: boolean;
  readonly dashboardUrl?: string | null;
}

/** A session that behaves like the harness, without one. */
function fakeSession(script: Script = {}): ChatSession & { readonly sent: TurnInput[] } {
  const sent: TurnInput[] = [];
  let tasks = 0;
  const reply = (view: TaskView, input: TurnInput): TaskView => {
    if (input.text.startsWith('/')) {
      // A command: the harness answers with a note and no task status.
      return { ...view, items: [...view.items, { kind: 'note', id: 'n', text: 'Model set.' }] };
    }
    const said: TranscriptItem = {
      kind: 'agent',
      id: `a${String(sent.length)}`,
      text: input.a2uiAction === undefined ? 'It ships today.' : 'The refund is filed.',
      streaming: false,
      a2ui: [],
    };
    const answer = input.a2uiAction === undefined ? (script.answer ?? said) : said;
    const state: ViewState =
      answer.kind === 'ask' ? 'awaiting-user-input' : 'awaiting-next-interaction';
    return { ...view, state, items: [...view.items, answer] };
  };
  return {
    sent,
    commands: [{ name: 'model', description: 'm', scope: 'harness' }],
    dashboardUrl: script.dashboardUrl ?? null,
    async *send(input: TurnInput, view: TaskView = EMPTY_VIEW): AsyncIterable<TaskView> {
      sent.push(input);
      const base = isOpen(view) ? view : { ...view, taskId: null };
      const started =
        input.text === '' ? base : withUserMessage(base, `u${String(sent.length)}`, input.text);
      yield started;
      await script.hold;
      if (script.failWith !== undefined) {
        // oxlint-disable-next-line typescript/only-throw-error -- a rejection that is not an Error is one of the cases
        throw script.failWith;
      }
      if (started.taskId === null && !input.text.startsWith('/')) {
        tasks += 1;
      }
      const taskId = input.text.startsWith('/') ? started.taskId : `t${String(tasks)}`;
      yield reply({ ...started, taskId, contextId: 'c1' }, input);
    },
    complete: (view: TaskView): Promise<TaskView> =>
      Promise.resolve({ ...view, state: 'completed' }),
    cancel: (view: TaskView): Promise<TaskView> =>
      script.cancelFails === true
        ? Promise.reject(new Error('cancel refused'))
        : Promise.resolve({ ...view, state: 'canceled' }),
  };
}

function screen(session: ChatSession) {
  const drawn = render(<ChatScreen session={session} />);
  const { container } = drawn;
  const field = container.querySelector('textarea');
  if (field === null) {
    throw new Error('The chat has no input.');
  }
  const button = (key: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent.includes(t(key)),
    );
    if (found === undefined) {
      throw new Error(`No button "${t(key)}".`);
    }
    return found;
  };
  return {
    ...drawn,
    field,
    button,
    state: (): string => container.querySelector('[data-slot="state-pill"]')?.textContent ?? '',
    alert: (): string => container.querySelector('[role="alert"]')?.textContent ?? '',
    say: (text: string): void => {
      fireEvent.change(field, { target: { value: text } });
      fireEvent.keyDown(field, { key: 'Enter' });
    },
    press: (key: string): void => {
      fireEvent.click(button(key));
    },
  };
}

const named = (state: ViewState): string => t(`view.state.${state}`);

describe('ChatScreen', () => {
  /**
   * Feature: Web renderer
   * Scenario: A turn shows the message at once, the state while working, and the answer
   *   Given the chat on a session whose answer is held back
   *   When the user sends a message
   *   Then the message is shown and the state reads "Working", with Send disabled
   *   When the answer arrives
   *   Then it is shown, the state reads "Waiting for you", and the task can be completed
   * Requirement: docs/specs/issue-3/requirements.md R20.2, R20.3
   */
  test('A turn shows the message at once, the state while working, and the answer', async () => {
    const held = gate();
    const session = fakeSession({ hold: held.opened });
    const chat = screen(session);
    expect(chat.state()).toBe(named('idle'));
    chat.say('Where is my order?');
    await waitFor(() => {
      expect(chat.state()).toBe(named('working'));
    });
    expect(chat.container.querySelector('[data-slot="user-message"]')?.textContent).toBe(
      'Where is my order?',
    );
    expect(chat.button('view.action.complete').disabled).toBe(true);
    // A second message while the first is in flight is not sent.
    chat.say('And another thing');
    expect(session.sent.length).toBe(1);
    held.open();
    await waitFor(() => {
      expect(chat.state()).toBe(named('awaiting-next-interaction'));
    });
    expect(chat.container.querySelector('[data-slot="answer"]')?.textContent).toBe(
      'It ships today.',
    );
    await waitFor(() => {
      expect(chat.button('view.action.complete').disabled).toBe(false);
    });
  });

  test('Complete ends the task; the next message starts a new one', async () => {
    const session = fakeSession();
    const chat = screen(session);
    chat.say('Where is my order?');
    await waitFor(() => {
      expect(chat.button('view.action.complete').disabled).toBe(false);
    });
    chat.press('view.action.complete');
    await waitFor(() => {
      expect(chat.state()).toBe(named('completed'));
    });
    expect(chat.field.getAttribute('placeholder')).toBe(t('view.input.placeholder.closed'));
    chat.say('One more');
    await waitFor(() => {
      expect(chat.state()).toBe(named('awaiting-next-interaction'));
    });
    expect(chat.container.querySelectorAll('[data-slot="answer"]').length).toBe(2);
  });

  /**
   * Feature: Web renderer
   * Scenario: Cancel interrupts a turn in flight, and the turn cannot reopen the task
   *   Given a turn whose answer is held back
   *   When the user presses "Cancel task"
   *   Then the state reads "Canceled"
   *   When the held answer arrives after all
   *   Then the state still reads "Canceled", and no error is shown
   * Requirement: docs/specs/issue-3/requirements.md R20.3
   */
  test('Cancel interrupts a turn in flight, and the turn cannot reopen the task', async () => {
    const held = gate();
    const first = fakeSession();
    const chat = screen(first);
    chat.say('Where is my order?');
    await waitFor(() => {
      expect(chat.button('view.action.cancel').disabled).toBe(false);
    });
    chat.unmount();

    const session = fakeSession({ hold: held.opened, failWith: new Error('stream closed') });
    const live = screen({
      ...session,
      // The task exists as soon as the turn starts, as it does once the harness has answered.
      async *send(input, view) {
        for await (const next of session.send(input, view)) {
          yield { ...next, taskId: 't1' };
        }
      },
    });
    live.say('Where is my order?');
    await waitFor(() => {
      expect(live.button('view.action.cancel').disabled).toBe(false);
    });
    live.press('view.action.cancel');
    await waitFor(() => {
      expect(live.state()).toBe(named('canceled'));
    });
    held.open();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    });
    expect(live.state()).toBe(named('canceled'));
    expect(live.alert()).toBe('');
  });

  test('a turn that fails says why, and the task is where it was', async () => {
    const chat = screen(fakeSession({ failWith: new Error('connection lost') }));
    chat.say('Where is my order?');
    await waitFor(() => {
      expect(chat.alert()).toBe(t('web.error.turn', { reason: 'connection lost' }));
    });
    expect(chat.state()).toBe(named('idle'));
    chat.unmount();

    const odd = screen(fakeSession({ failWith: 'no reason object' }));
    odd.say('Where is my order?');
    await waitFor(() => {
      expect(odd.alert()).toBe(t('web.error.turn', { reason: 'no reason object' }));
    });
  });

  test('a cancel the harness refuses is reported', async () => {
    const chat = screen(fakeSession({ cancelFails: true }));
    chat.say('Where is my order?');
    await waitFor(() => {
      expect(chat.button('view.action.cancel').disabled).toBe(false);
    });
    chat.press('view.action.cancel');
    await waitFor(() => {
      expect(chat.alert()).toBe(t('web.error.turn', { reason: 'cancel refused' }));
    });
  });

  /**
   * Feature: Web renderer
   * Scenario: A command's reply leaves the task's state alone
   *   Given the chat before any task
   *   When the user sends a command
   *   Then the reply is shown as a note and the state is "Ready" again, not "Working"
   * Requirement: docs/specs/issue-3/requirements.md R23.1
   */
  test("A command's reply leaves the task's state alone", async () => {
    const chat = screen(fakeSession());
    chat.say('/model gpt');
    await waitFor(() => {
      expect(chat.container.querySelector('[data-slot="note"]')?.textContent).toBe('Model set.');
    });
    await waitFor(() => {
      expect(chat.state()).toBe(named('idle'));
    });
    expect(chat.container.querySelector('[data-slot="command"]')?.textContent).toBe('/model');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: Pressing a button of an A2UI surface sends the action to the harness
   *   Given an answer that carries a basic-catalog surface
   *   When the user presses its button
   *   Then the session is sent an empty text with the A2UI 1.0 action message
   *   And the agent's reply is shown
   * Requirement: docs/specs/issue-3/requirements.md R19.4
   */
  test('Pressing a button of an A2UI surface sends the action to the harness', async () => {
    const form: TranscriptItem = {
      kind: 'agent',
      id: 'form',
      text: 'Please fill this in.',
      streaming: false,
      a2ui: [sampleSurface()],
    };
    const session = fakeSession({ answer: form });
    const chat = screen(session);
    chat.say('I want a refund');
    await waitFor(() => {
      expect(chat.container.querySelector('[data-slot="a2ui"] button')).not.toBe(null);
    });
    await waitFor(() => {
      expect(chat.button('view.action.complete').disabled).toBe(false);
    });
    const submit = chat.container.querySelector('[data-slot="a2ui"] button');
    if (submit !== null) {
      fireEvent.click(submit);
    }
    await waitFor(() => {
      expect(session.sent.length).toBe(2);
    });
    const action = session.sent[1];
    expect(action?.text).toBe('');
    expect(action?.a2uiAction).toMatchObject({
      version: '1.0',
      action: { name: 'submitRefund', surfaceId: 'main' },
    });
  });

  test('an agent that asks changes the state and the placeholder', async () => {
    const chat = screen(fakeSession({ answer: { kind: 'ask', id: 'q', text: 'Which one?' } }));
    chat.say('Refund please');
    await waitFor(() => {
      expect(chat.state()).toBe(named('awaiting-user-input'));
    });
    expect(chat.field.getAttribute('placeholder')).toBe(t('view.input.placeholder.ask'));
    expect(chat.container.querySelector('[data-slot="ask"]')?.textContent).toContain('Which one?');
  });
});

describe('App', () => {
  /**
   * Feature: Web renderer
   * Scenario: The page connects, then shows the chat
   *   Given a harness that answers
   *   When the page opens
   *   Then it says it is connecting, and then shows the chat with the harness's Temporal link
   * Requirement: docs/specs/issue-3/requirements.md R20.1, R17.10
   */
  test('The page connects, then shows the chat', async () => {
    const opened = gate();
    const session = fakeSession({ dashboardUrl: 'https://temporal.test' });
    const connect = async (): Promise<ChatSession> => {
      await opened.opened;
      return session;
    };
    const { container } = render(<App connect={connect} />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(t('web.connecting'));
    opened.open();
    await waitFor(() => {
      expect(container.querySelector('textarea')).not.toBe(null);
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://temporal.test');
  });

  test('a harness that cannot be reached is reported, in words', async () => {
    const refuse = (): Promise<ChatSession> => Promise.reject(new Error('connection refused'));
    const { container, unmount } = render(<App connect={refuse} />);
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        t('web.error.connect', { reason: 'connection refused' }),
      );
    });
    unmount();
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error is the case
    const odd = (): Promise<ChatSession> => Promise.reject('offline');
    const second = render(<App connect={odd} />);
    await waitFor(() => {
      expect(second.container.querySelector('[role="alert"]')?.textContent).toContain('offline');
    });
  });

  test('a page closed while connecting does nothing when the connection arrives', async () => {
    const opened = gate();
    const connect = async (): Promise<ChatSession> => {
      await opened.opened;
      return fakeSession();
    };
    const { container, unmount } = render(<App connect={connect} />);
    unmount();
    opened.open();
    await act(async () => {
      await opened.opened;
    });
    expect(container.querySelector('textarea')).toBe(null);
  });
});
