import { afterEach, describe, expect, test } from 'bun:test';

import { TaskState } from '@a2a-js/sdk';
import { render } from 'ink-testing-library';
import { createElement } from 'react';

import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { t } from '../../src/kernel/strings.ts';
import { App } from '../../src/surface/renderer/tui/app.tsx';
import { TuiController } from '../../src/surface/renderer/tui/controller.ts';
import {
  BASIC_CATALOG_ID,
  createTuiSurface,
  runTui,
} from '../../src/surface/renderer/tui/index.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { ScriptedTurn } from '../../src/testing/scripted-llm.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { REFUND_FORM_TEXT } from '../support/a2ui-form.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import { FakeDisplay, FakeKeyboard, KEY, stripColour, waitFor } from '../support/tui.ts';

let running: TestHarness | undefined = undefined;
let unmount: (() => void) | undefined = undefined;

afterEach(async () => {
  unmount?.();
  unmount = undefined;
  await running?.stop();
  running = undefined;
});

const lookup = defineTool({
  id: 'lookup',
  description: 'Look an order up.',
  inputSchema: { type: 'object' },
  retrySafe: true,
  invoke: () => Promise.resolve(textResult('order found')),
});

/** The real application on a fake terminal, against a real harness with a scripted model. */
async function openTui(turns: readonly ScriptedTurn[], llmDelayMs?: number) {
  const harness = await startHarness({
    turns,
    tools: [lookup],
    ...(llmDelayMs === undefined ? {} : { llmDelayMs }),
  });
  running = harness;
  const session = await HarnessSession.connect(harness.url, { a2uiCatalogs: [BASIC_CATALOG_ID] });
  const controller = new TuiController(session);
  const screen = render(createElement(App, { controller }));
  unmount = screen.unmount;
  const frames = (): string[] => screen.frames.map((frame) => stripColour(frame));
  const frame = (): string => stripColour(screen.lastFrame() ?? '');
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  };
  return {
    harness,
    controller,
    frames,
    frame,
    rawFrames: (): string => screen.frames.join(''),
    /** Presses keys one after another, letting the screen redraw in between. */
    press: async (...keys: string[]): Promise<void> => {
      for (const key of keys) {
        screen.stdin.write(key);
        // oxlint-disable-next-line no-await-in-loop -- keys are pressed in order
        await settle();
      }
    },
    /** Types a line and presses Enter. */
    enter: async (text: string): Promise<void> => {
      screen.stdin.write(text);
      await settle();
      screen.stdin.write(KEY.enter);
    },
    shows: async (...texts: string[]): Promise<void> => {
      await waitFor(() => texts.every((text) => frame().includes(text)), frame);
    },
    resting: async (): Promise<void> => {
      await waitFor(() => !controller.getState().busy, frame);
      await settle();
    },
  };
}

describe('terminal UI', () => {
  /**
   * Feature: TUI renderer
   * Scenario: The terminal UI streams an answer and shows the task state
   *   Given the terminal UI connected to a harness
   *   When the user types a message and presses Enter, and the agent calls a tool and answers
   *   Then the answer appears incrementally with a cursor while the status line says "Working"
   *   And the finished screen shows the message, the tool call, the answer, the state
   *       "Waiting for you" in words with its glyph, and the complete and cancel keys
   * Requirement: docs/specs/issue-3/requirements.md R21.1 (R20.2, R20.3)
   */
  test('The terminal UI streams an answer and shows the task state', async () => {
    const ui = await openTui(
      [callTools(call('c1', 'lookup')), say('Your order is on its way to you today.')],
      5,
    );
    expect(ui.frame()).toContain(`○ ${t('view.state.idle')}`);
    expect(ui.frame()).toContain(t('view.input.placeholder'));
    await ui.enter('Where is my order?');
    await ui.shows(
      'Your order is on its way to you today.',
      t('view.state.awaiting-next-interaction'),
    );
    await ui.resting();

    const working = ui.frames().filter((frame) => frame.includes(`◐ ${t('view.state.working')}`));
    expect(working.length).toBeGreaterThan(0);
    const partial = working.filter((frame) => /agent Your order[^\n]*▍/u.test(frame));
    expect(partial.length).toBeGreaterThan(1);
    expect(partial.some((frame) => !frame.includes('to you today.'))).toBe(true);

    const final = ui.frame();
    expect(final).toContain('you   Where is my order?');
    expect(final).toContain('✓ lookup');
    expect(final).toContain('agent Your order is on its way to you today.');
    expect(final).not.toMatch(/today\.▍/u);
    expect(final).toContain(`● ${t('view.state.awaiting-next-interaction')}`);
    expect(final).toContain(t('tui.hint.complete'));
    expect(final).toContain(t('tui.hint.cancel'));
  });

  /**
   * Feature: TUI renderer
   * Scenario: The terminal UI asks for input and continues on the reply
   *   Given a task in which the agent asks the user a question
   *   When the question arrives
   *   Then it is drawn in a labelled block of its own and the status line says "Needs your input"
   *   When the user types the answer
   *   Then the same task continues and the agent's next answer appears
   * Requirement: docs/specs/issue-3/requirements.md R21.1 (R20.4)
   */
  test('The terminal UI asks for input and continues on the reply', async () => {
    const ui = await openTui([
      callTools(call('c1', 'ask_user', { question: 'Refund or store credit?' })),
      say('Refund filed.'),
    ]);
    await ui.enter('Help me with order A-1041');
    await ui.shows('Refund or store credit?');
    await ui.resting();
    const asked = ui.frame();
    expect(asked).toMatch(/agent ┃ Needs your input\n\s+┃ Refund or store credit\?/u);
    expect(asked).toContain(`▲ ${t('view.state.awaiting-user-input')}`);
    expect(asked).toContain(t('view.input.placeholder.ask'));
    const { taskId } = ui.controller.getState().view;

    await ui.enter('Refund');
    await ui.shows('agent Refund filed.', t('view.state.awaiting-next-interaction'));
    expect(ui.controller.getState().view.taskId).toBe(taskId);
    expect(ui.harness.llm.requests.length).toBe(2);
  });

  /**
   * Feature: TUI renderer
   * Scenario: Ctrl+D completes and Ctrl+X cancels the task
   *   Given an open task in the terminal UI
   *   When the user presses Ctrl+D
   *   Then the task is completed without the model being invoked, and the hints offer a new task
   *   When the user sends another message
   *   Then a new task starts
   *   When the user presses Ctrl+X
   *   Then that task is canceled
   * Requirement: docs/specs/issue-3/requirements.md R21.1 (R20.3)
   */
  test('Ctrl+D completes and Ctrl+X cancels the task', async () => {
    const ui = await openTui([say('First answer.'), say('Second answer.')]);
    await ui.enter('One');
    await ui.shows('First answer.');
    await ui.resting();
    const first = ui.controller.getState().view.taskId;

    await ui.press(KEY.ctrlD);
    await ui.shows(`✓ ${t('view.state.completed')}`, t('tui.hint.new'));
    await ui.resting();
    expect(ui.frame()).not.toContain(t('tui.hint.complete'));
    expect(ui.frame()).toContain(t('view.input.placeholder.closed'));
    expect(ui.harness.llm.requests.length).toBe(1);

    await ui.enter('Two');
    await ui.shows('Second answer.', t('view.state.awaiting-next-interaction'));
    await ui.resting();
    const second = ui.controller.getState().view.taskId;
    expect(second).not.toBe(first);
    expect(ui.frame()).toContain('First answer.');

    await ui.press(KEY.ctrlX);
    await ui.shows(`■ ${t('view.state.canceled')}`);
    const stored = await ui.harness.client.getTask({ tenant: '', id: second ?? '' });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(ui.harness.llm.requests.length).toBe(2);
  });

  /**
   * Feature: TUI renderer
   * Scenario: A matched command is highlighted and never reaches the model
   *   Given the terminal UI connected to a harness that lists its commands
   *   When the user types a slash and something that is not a command
   *   Then the commands are listed
   *   When the user types /model
   *   Then the command is set off and a line says it will not be sent to the model
   *   When the user presses Enter
   *   Then the command's reply is shown as a note, no task is created and the model is not invoked
   * Requirement: docs/specs/issue-3/requirements.md R21.1 (R20.5)
   */
  test('A matched command is highlighted and never reaches the model', async () => {
    const ui = await openTui([]);
    await ui.press('/mod');
    expect(ui.frame()).toContain(t('view.command.list', { names: '' }).trim());
    expect(ui.frame()).toContain('/model');
    expect(ui.frame()).toContain('/exit');
    expect(ui.frame()).not.toContain(t('view.command.hint', { name: '/mod' }));

    await ui.press('el');
    expect(ui.frame()).toContain(t('view.command.hint', { name: '/model' }));
    expect(ui.frame()).not.toContain(t('view.command.list', { names: '' }).trim());
    await ui.press(' x', KEY.backspace, KEY.backspace);
    expect(ui.frame()).toContain('> /model▍');

    await ui.press(KEY.enter);
    await ui.shows('scripted/model');
    await ui.resting();
    expect(ui.controller.getState().view.taskId).toBeNull();
    expect(ui.controller.getState().view.items.at(-1)?.kind).toBe('note');
    expect(ui.frame()).toContain(`○ ${t('view.state.idle')}`);
    expect(ui.harness.llm.requests.length).toBe(0);
  });

  /**
   * Feature: TUI renderer
   * Scenario: A basic-catalog A2UI form is drawn and its button sends an action
   *   Given an answer that carries an A2UI form: a title, a choice, a checkbox and a button
   *   When it is drawn
   *   Then the form's text and controls are on the screen
   *   When the user moves with Tab, picks another option, ticks the checkbox and presses the button
   *   Then the action reaches the model with the values the user set, and the agent answers
   * Requirement: docs/specs/issue-3/requirements.md R19.4
   */
  test('A basic-catalog A2UI form is drawn and its button sends an action', async () => {
    const ui = await openTui([say(REFUND_FORM_TEXT), say('Refund filed.')]);
    await ui.enter('I want a refund');
    await ui.shows('Refund details', '[ Submit refund ]');
    await ui.resting();
    expect(ui.frame()).toContain('agent Please fill this in.');
    expect(ui.frame()).toContain('  (*) Arrived damaged');
    expect(ui.frame()).toContain('  ( ) Wrong item');
    expect(ui.frame()).toContain('  [ ] I can send a photo');
    expect(ui.frame()).toContain(t('tui.a2ui.hint'));

    await ui.press(KEY.tab);
    expect(ui.frame()).toContain('> (*) Arrived damaged');
    await ui.press(KEY.down);
    expect(ui.frame()).toContain('> ( ) Wrong item');
    await ui.press(KEY.space);
    expect(ui.frame()).toContain('> (*) Wrong item');
    expect(ui.frame()).toContain('  ( ) Arrived damaged');
    await ui.press(KEY.tab, KEY.space);
    expect(ui.frame()).toContain('> [x] I can send a photo');
    await ui.press(KEY.tab);
    expect(ui.frame()).toContain('> [ Submit refund ]');
    await ui.press(KEY.enter);

    await ui.shows('agent Refund filed.');
    const sent = JSON.stringify(ui.harness.llm.requests[1]?.messages);
    expect(sent).toContain('submitRefund');
    expect(sent).toContain('wrong');
    expect(sent).not.toContain('"damaged\\"]');
    expect(sent).toMatch(/photo[^a-z]*true/u);
    expect(ui.harness.llm.requests.length).toBe(2);
  });

  /**
   * Feature: Security
   * Scenario: Terminal escape sequences in a reply are neutralised
   *   Given an agent whose answer carries escape sequences that retitle the window,
   *         clear the screen and move the cursor
   *   When the terminal UI draws the answer
   *   Then no frame written to the terminal contains those sequences or a bell,
   *        and the readable text around them is shown
   * Requirement: docs/specs/issue-3/requirements.md abuse case 6
   */
  test('Terminal escape sequences in a reply are neutralised', async () => {
    const hostile =
      'safe \u001B]0;owned\u0007\u001B[2J\u001B[1;1Hstart \u001B]8;;http://evil.example\u001B\\link\u001B]8;;\u001B\\ end.';
    const ui = await openTui([say(hostile)]);
    await ui.enter('Go');
    await ui.shows('end.');
    await ui.resting();
    expect(ui.frame()).toContain('agent safe start link end.');
    const written = ui.rawFrames();
    expect(written.includes('\u0007')).toBe(false);
    expect(written.includes('\u001B]')).toBe(false);
    expect(written.includes('\u001B[2J')).toBe(false);
    expect(written.includes('\u001B[1;1H')).toBe(false);
    expect(written).not.toContain('owned');
    expect(written).not.toContain('evil.example');
  });

  /**
   * Feature: TUI renderer
   * Scenario: Without a TTY the interface prints plain lines
   *   Given output that is not a terminal
   *   When the user pipes in a message, the answers to a form, /complete and /exit
   *   Then each event is one plain line without any escape code, the form is printed as
   *        numbered questions with an example answer, the answers reach the model,
   *        the task is completed and the interface ends
   * Requirement: docs/specs/issue-3/requirements.md R21.2
   */
  test('Without a TTY the interface prints plain lines', async () => {
    running = await startHarness({
      tools: [lookup],
      turns: [callTools(call('c1', 'lookup')), say(REFUND_FORM_TEXT), say('Refund filed.')],
    });
    const keyboard = new FakeKeyboard();
    const display = new FakeDisplay(false);
    const surface = createTuiSurface({ stdin: keyboard, stdout: display, env: {} });
    const done = surface.open(running.url);
    const printed = async (text: string): Promise<void> => {
      await waitFor(
        () => display.raw.includes(text),
        () => display.raw,
      );
    };

    await printed(t('tui.plain.hint'));
    keyboard.write('I want a refund\n');
    await printed('answer as: 1,n');
    expect(display.raw).toContain('[working]\n');
    expect(display.raw).toMatch(/tool: lookup ok \d+ ms\n/u);
    expect(display.raw).toContain('agent: Please fill this in.\n');
    expect(display.raw).toContain('agent: [form] Refund details\n');
    expect(display.raw).toContain('  1. What happened? (1) Arrived damaged (2) Wrong item\n');
    expect(display.raw).toContain('  2. I can send a photo (y/n)\n');
    expect(display.raw).toContain('[waiting for you] answer as: 1,n\n');

    keyboard.write('2,y\n');
    await printed('agent: Refund filed.\n');
    const sent = JSON.stringify(running.llm.requests[2]?.messages);
    expect(sent).toContain('submitRefund');
    expect(sent).toContain('wrong');

    keyboard.write('/complete\n');
    await printed('[completed]\n');
    keyboard.write('/exit\n');
    await done;
    expect(display.raw.includes('\u001B')).toBe(false);
    expect(running.llm.requests.length).toBe(3);
  });

  /**
   * Feature: TUI renderer
   * Scenario: Leaving the terminal UI restores the terminal
   *   Given the terminal UI running on a terminal in raw mode
   *   When the user enters /exit — or, in a second run, presses Ctrl+C
   *   Then the application unmounts, the terminal is taken out of raw mode, and
   *        opening the surface resolves
   * Requirement: docs/specs/issue-3/requirements.md R21.3
   */
  test('Leaving the terminal UI restores the terminal', async () => {
    running = await startHarness({ turns: [say('Hello there.')] });
    for (const leave of ['/exit\r', KEY.ctrlC]) {
      const keyboard = new FakeKeyboard();
      const display = new FakeDisplay(true);
      const done = runTui({
        url: running.url,
        stdin: keyboard,
        stdout: display,
        env: {},
        model: 'scripted/model',
        effort: 'medium',
      });
      // oxlint-disable-next-line no-await-in-loop -- one run after the other
      await waitFor(
        () => display.text.includes(t('view.state.idle')),
        () => display.text,
      );
      expect(display.text).toContain('scripted/model');
      expect(display.text).toContain(t('tui.status.effort', { effort: 'medium' }));
      expect(keyboard.rawModes).toEqual([true]);
      keyboard.write(leave);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await done;
      expect(keyboard.rawModes).toEqual([true, false]);
    }
    expect(running.llm.requests.length).toBe(0);
  });
});
