import { describe, expect, test } from 'bun:test';

import {
  AskBlock,
  Composer,
  StatePill,
  TaskHeader,
  ToolGroup,
  Transcript,
  fireEvent,
  render,
  webTest,
} from '../../../../../test/web/index.ts';
import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';
import type { TaskView, TranscriptItem, ViewState } from '../../../view.ts';
import { EMPTY_VIEW } from '../../../view.ts';

webTest();

const COMMANDS: readonly CommandInfo[] = [
  { name: 'model', description: 'm', scope: 'harness' },
  { name: 'effort', description: 'e', scope: 'harness' },
];

const nothing = (): void => undefined;

/** Clicks an element the way a user's click reaches React. */
function press(element: Element | null | undefined): void {
  if (element === null || element === undefined) {
    throw new Error('Nothing to press.');
  }
  fireEvent.click(element);
}

function view(state: ViewState, ...items: TranscriptItem[]): TaskView {
  return { ...EMPTY_VIEW, taskId: 't1', contextId: 'c1', state, items };
}

function tool(
  id: string,
  ok: boolean,
  done = true,
  durationMs: number | null = 420,
): TranscriptItem {
  return { kind: 'tool', id, name: `tool_${id}`, done, ok, durationMs };
}

describe('StatePill', () => {
  /**
   * Feature: Web renderer
   * Scenario: The state pill says the state in words
   *   Given each state a task can be in
   *   When the pill is drawn
   *   Then it reads the state's name, and carries the state for styling
   * Requirement: docs/specs/issue-3/requirements.md R20.3, R20.6
   */
  test('The state pill says the state in words', () => {
    const states: ViewState[] = [
      'idle',
      'working',
      'awaiting-next-interaction',
      'awaiting-user-input',
      'completed',
      'canceled',
      'failed',
    ];
    for (const state of states) {
      const { container, unmount } = render(<StatePill state={state} />);
      const pill = container.querySelector<HTMLElement>('[data-slot="state-pill"]');
      expect(pill?.textContent).toBe(t(`view.state.${state}`));
      expect(pill?.dataset['state']).toBe(state);
      expect(pill?.getAttribute('role')).toBe('status');
      unmount();
    }
  });
});

describe('TaskHeader', () => {
  const header = (shown: TaskView, dashboardUrl: string | null = null, busy = false) => {
    const pressed: string[] = [];
    const drawn = render(
      <TaskHeader
        view={shown}
        dashboardUrl={dashboardUrl}
        busy={busy}
        onComplete={() => {
          pressed.push('complete');
        }}
        onCancel={() => {
          pressed.push('cancel');
        }}
      />,
    );
    const button = (key: string): HTMLButtonElement | null =>
      [...drawn.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === t(key),
      ) ?? null;
    return { ...drawn, pressed, button };
  };

  test('before there is a task, the controls are disabled and the task has no name', () => {
    const { container, button } = header(EMPTY_VIEW);
    expect(button('view.action.complete')?.disabled).toBe(true);
    expect(button('view.action.cancel')?.disabled).toBe(true);
    expect(container.textContent).toContain(t('web.task.new'));
    expect(container.querySelector('a')).toBe(null);
  });

  test('an open task is named after the first message and can be completed or canceled', () => {
    const shown = view('awaiting-next-interaction', { kind: 'user', id: 'u', text: 'Refund A-1' });
    const { container, button, pressed } = header(shown);
    expect(container.querySelector('h1')?.textContent).toBe('Refund A-1');
    press(button('view.action.complete'));
    press(button('view.action.cancel'));
    expect(pressed).toEqual(['complete', 'cancel']);
  });

  test('a turn in flight can be canceled but not completed', () => {
    const { button } = header(view('working'), null, true);
    expect(button('view.action.complete')?.disabled).toBe(true);
    expect(button('view.action.cancel')?.disabled).toBe(false);
  });

  test('a closed task has both controls disabled', () => {
    for (const state of ['completed', 'canceled', 'failed'] as const) {
      const { button, unmount } = header(view(state));
      expect(button('view.action.complete')?.disabled).toBe(true);
      expect(button('view.action.cancel')?.disabled).toBe(true);
      unmount();
    }
  });

  test('the Temporal link points to the workflow, or else to the dashboard, when either exists', () => {
    const workflow = header(
      { ...view('working'), workflowUrl: 'https://temporal.test/wf/1' },
      'https://temporal.test',
    );
    const link = workflow.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://temporal.test/wf/1');
    expect(link?.textContent).toContain(t('view.action.temporal'));
    expect(link?.getAttribute('rel')).toContain('noopener');
    workflow.unmount();
    const dashboard = header(view('working'), 'http://localhost:8233');
    expect(dashboard.container.querySelector('a')?.getAttribute('href')).toBe(
      'http://localhost:8233',
    );
    dashboard.unmount();
    // An address that is not a web address is never made a link.
    const hostile = header(view('working'), 'javascript:alert(1)');
    expect(hostile.container.querySelector('a')).toBe(null);
  });
});

describe('AskBlock', () => {
  /**
   * Feature: Web renderer
   * Scenario: A request for input is a labelled block of its own
   *   Given a question from the agent
   *   When it is drawn
   *   Then it sits in a region labelled "Needs your input", apart from ordinary answers
   *   And control characters in the question are not shown
   * Requirement: docs/specs/issue-3/requirements.md R20.4
   */
  test('A request for input is a labelled block of its own', () => {
    const { container } = render(<AskBlock text={'Refund or\u001B[2J credit?'} />);
    const block = container.querySelector('[data-slot="ask"]');
    expect(block?.getAttribute('aria-label')).toBe(t('view.ask.label'));
    expect(block?.textContent).toBe(`${t('view.ask.label')}Refund or[2J credit?`);
    expect(block?.className).toContain('border-attention');
  });
});

describe('ToolGroup', () => {
  /**
   * Feature: Web renderer
   * Scenario: Tool calls are one group that lists each call with its outcome
   *   Given three calls: one ok, one failed, one still running
   *   When the group is drawn
   *   Then the summary counts them and says how many failed
   *   And each call shows its name, its outcome in words, and its duration when known
   *   And the group can be folded and unfolded
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('Tool calls are one group that lists each call with its outcome', () => {
    const calls = [tool('a', true), tool('b', false, true, 1500), tool('c', true, false, null)];
    const { container } = render(
      <ToolGroup calls={calls.filter((call) => call.kind === 'tool')} />,
    );
    const text = container.textContent;
    expect(text).toContain(t('web.tools.summary', { count: 3 }));
    expect(text).toContain(t('web.tools.failed', { count: 1 }));
    const rows = [...container.querySelectorAll('[data-slot="tool-call"]')].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual([
      `tool_a${t('view.tool.ok')}420 ms`,
      `tool_b${t('view.tool.failed')}1.5 s`,
      `tool_c${t('view.tool.running')}`,
    ]);
    const trigger = container.querySelector('button');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    press(trigger);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  test('one call is counted in the singular, with no failure count', () => {
    const calls = [tool('a', true)];
    const { container } = render(
      <ToolGroup calls={calls.filter((call) => call.kind === 'tool')} />,
    );
    expect(container.textContent).toContain(t('web.tools.summary.one'));
    expect(container.textContent).not.toContain('failed');
  });
});

describe('Transcript', () => {
  const transcript = (shown: TaskView) =>
    render(<Transcript view={shown} commands={COMMANDS} onAction={nothing} />);

  /**
   * Feature: Web renderer
   * Scenario: A command the user sent is coloured in the transcript
   *   Given a transcript with "/model gpt" and with an ordinary message
   *   When it is drawn
   *   Then the command word alone is marked as a command, and the ordinary message is not
   * Requirement: docs/specs/issue-3/requirements.md R20.5
   */
  test('A command the user sent is coloured in the transcript', () => {
    const { container } = transcript(
      view(
        'idle',
        { kind: 'user', id: 'u1', text: '/model gpt' },
        { kind: 'note', id: 'n1', text: 'Model set to gpt.' },
        { kind: 'user', id: 'u2', text: 'hello /model' },
      ),
    );
    const marked = [...container.querySelectorAll('[data-slot="command"]')];
    expect(marked.map((element) => element.textContent)).toEqual(['/model']);
    expect(marked[0]?.className).toContain('text-command');
    const messages = [...container.querySelectorAll('[data-slot="user-message"]')];
    expect(messages.map((element) => element.textContent)).toEqual(['/model gpt', 'hello /model']);
    expect(container.querySelector('[data-slot="note"]')?.textContent).toBe('Model set to gpt.');
  });

  test('the log is announced politely and says when the agent is busy', () => {
    const { container } = transcript(view('working'));
    const log = container.querySelector('[role="log"]');
    expect(log?.getAttribute('aria-live')).toBe('polite');
    expect(log?.getAttribute('aria-busy')).toBe('true');
    expect(log?.getAttribute('aria-label')).toBe(t('web.log.label'));
  });

  test('an answer still arriving is marked as streaming, and markup in it is only text', () => {
    const { container } = transcript(
      view(
        'working',
        tool('a', true),
        { kind: 'agent', id: 'a1', text: '<b>Thanks</b>, filing', streaming: true, a2ui: [] },
        { kind: 'ask', id: 'q1', text: 'Which one?' },
        { kind: 'agent', id: 'a2', text: '', streaming: false, a2ui: [] },
      ),
    );
    const answers = [...container.querySelectorAll<HTMLElement>('[data-slot="answer"]')];
    expect(answers.length).toBe(1);
    expect(answers[0]?.dataset['streaming']).toBe('true');
    expect(answers[0]?.textContent).toBe('<b>Thanks</b>, filing');
    expect(container.querySelector('b')).toBe(null);
    expect(container.querySelectorAll('[data-slot="agent-turn"]').length).toBe(1);
    expect(container.querySelector('[data-slot="ask"]')?.textContent).toContain('Which one?');
    expect(container.querySelector('[data-slot="tool-group"]')).not.toBe(null);
  });
});

describe('Composer', () => {
  const composer = (state: ViewState = 'idle', busy = false) => {
    const sent: string[] = [];
    const drawn = render(
      <Composer
        state={state}
        commands={COMMANDS}
        busy={busy}
        onSend={(text) => {
          sent.push(text);
        }}
      />,
    );
    const field = drawn.container.querySelector('textarea');
    if (field === null) {
      throw new Error('The composer has no input.');
    }
    const type = (text: string): void => {
      fireEvent.change(field, { target: { value: text } });
    };
    const send = drawn.container.querySelector('button[type="submit"]');
    const hint = (): string => drawn.container.querySelector('[role="status"]')?.textContent ?? '';
    return { ...drawn, sent, field, type, send, hint };
  };

  /**
   * Feature: Web renderer
   * Scenario: Send is enabled only when there is something to send and nothing in flight
   *   Given an empty input
   *   Then Send is disabled
   *   When the user types only spaces
   *   Then Send is still disabled
   *   When the user types a message
   *   Then Send is enabled, and pressing it sends the trimmed text and empties the input
   *   And while a turn is in flight Send stays disabled whatever is typed
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('Send is enabled only when there is something to send and nothing in flight', () => {
    const idle = composer();
    expect(idle.send?.hasAttribute('disabled')).toBe(true);
    idle.type('   ');
    expect(idle.send?.hasAttribute('disabled')).toBe(true);
    idle.type('  hello  ');
    expect(idle.send?.hasAttribute('disabled')).toBe(false);
    const form = idle.container.querySelector('form');
    if (form !== null) {
      fireEvent.submit(form);
    }
    expect(idle.sent).toEqual(['hello']);
    expect(idle.field.value).toBe('');
    idle.unmount();

    const busy = composer('working', true);
    busy.type('hello');
    expect(busy.send?.hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(busy.field, { key: 'Enter' });
    expect(busy.sent).toEqual([]);
  });

  test('Enter sends, Shift+Enter and Enter during composition do not', () => {
    const { field, type, sent } = composer();
    type('one');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { key: 'a' });
    expect(sent).toEqual([]);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(sent).toEqual(['one']);
  });

  /**
   * Feature: Web renderer
   * Scenario: A matched command is coloured as it is typed
   *   Given the commands /model and /effort
   *   When the user types "/model gpt"
   *   Then the input is marked as a command and the hint says it will not reach the model
   *   When the user types "/unknown"
   *   Then the input is not marked and the hint lists the commands
   *   When the user types ordinary text
   *   Then there is no hint
   * Requirement: docs/specs/issue-3/requirements.md R20.5
   */
  test('A matched command is coloured as it is typed', () => {
    const { field, type, hint } = composer();
    type('/model gpt');
    expect(field.dataset['command']).toBe('true');
    expect(field.className).toContain('text-command');
    expect(hint()).toBe(t('view.command.hint', { name: '/model' }));
    type('/unknown');
    expect(field.dataset['command']).toBe('false');
    expect(field.className).not.toContain('text-command');
    expect(hint()).toBe(t('view.command.list', { names: '/model  /effort' }));
    type('hello');
    expect(hint()).toBe('');
  });

  test('the placeholder follows the state of the task', () => {
    const cases: [ViewState, string][] = [
      ['idle', 'view.input.placeholder'],
      ['awaiting-user-input', 'view.input.placeholder.ask'],
      ['completed', 'view.input.placeholder.closed'],
      ['canceled', 'view.input.placeholder.closed'],
      ['failed', 'view.input.placeholder.closed'],
    ];
    for (const [state, key] of cases) {
      const { field, unmount } = composer(state);
      expect(field.getAttribute('placeholder')).toBe(t(key));
      unmount();
    }
  });

  test('a chip writes its command into the input and gives it the focus', () => {
    const { container, field } = composer();
    const chips = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="chip"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['/model', '/effort']);
    press(chips[1]);
    expect(field.value).toBe('/effort ');
    expect(container.ownerDocument.activeElement).toBe(field);
  });

  test('attach and microphone are present, disabled, and say they come later', () => {
    const { container } = composer();
    for (const key of ['web.attach.label', 'web.voice.label']) {
      const button = container.querySelector(`button[aria-label="${t(key)}"]`);
      expect(button?.getAttribute('aria-disabled')).toBe('true');
    }
    expect(t('web.attach.label')).toContain(t('web.later'));
  });
});
