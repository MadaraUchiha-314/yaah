import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import { t } from '../../../kernel/strings.ts';
import { hostileSurface, refundForm } from '../../../../test/support/a2ui-form.ts';
import { FakeDisplay, renderToText, waitFor } from '../../../../test/support/tui.ts';
import type { TaskView, TranscriptItem, ViewState } from '../../view.ts';
import { EMPTY_VIEW } from '../../view.ts';
import { matchCommand } from './components.tsx';
import type { TuiSession } from './controller.ts';
import { TuiController } from './controller.ts';
import { BASIC_CATALOG_ID, isPlain, tuiRenderer, tuiSurface } from './index.ts';
import { runPlain } from './plain.ts';
import { formatDuration } from './transcript.tsx';

const view = (state: ViewState, ...items: TranscriptItem[]): TaskView => ({
  ...EMPTY_VIEW,
  taskId: 't1',
  contextId: 'c1',
  state,
  items,
});

const form = (a2ui: unknown[] = refundForm()): TranscriptItem => ({
  kind: 'agent',
  id: 'a',
  text: 'Please fill this in.',
  streaming: false,
  a2ui,
});

const COMMANDS = [{ name: 'model' }, { name: 'exit' }];

describe('terminal UI components', () => {
  test('the status line names the state with a glyph, then the task, model, effort and Temporal', () => {
    const frame = renderToText(view('working'), {
      taskName: 'Refund for order A-1041',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      dashboardUrl: 'http://127.0.0.1:8233',
    });
    expect(frame).toContain(
      '◐ Working · Refund for order A-1041 · gpt-6.1-sol · effort medium · Temporal: http://127.0.0.1:8233',
    );
    const own = renderToText(
      { ...view('failed'), workflowUrl: 'http://127.0.0.1:8233/wf/1\u001B[2J' },
      { dashboardUrl: 'http://127.0.0.1:8233' },
    );
    expect(own).toContain('✗ Failed · Temporal: http://127.0.0.1:8233/wf/1\n');
    expect(renderToText(view('canceled'))).toContain('■ Canceled\n');
  });

  test('the key hints follow the task: open, working, closed', () => {
    const openHints = renderToText(view('awaiting-next-interaction'));
    expect(openHints).toContain('^D complete · ^X cancel · ^O open in Temporal · /exit');
    const working = renderToText(view('working'), { busy: true });
    expect(working).toContain('^X cancel · ^O open in Temporal · ^C leave');
    expect(working).not.toContain(t('tui.hint.complete'));
    expect(renderToText(view('completed'))).toContain(
      'Type a message to start a new task · ^O open in Temporal · /exit',
    );
  });

  test('the input line sets a command off, explains it, or lists the commands', () => {
    expect(matchCommand('/model gpt', COMMANDS)).toBe('model');
    expect(matchCommand('/models', COMMANDS)).toBeNull();
    expect(matchCommand('model', COMMANDS)).toBeNull();
    expect(matchCommand('/', COMMANDS)).toBeNull();
    const matched = renderToText(view('idle'), { text: '/model gpt', commands: COMMANDS });
    expect(matched).toContain('> /model gpt▍');
    expect(matched).toContain(t('view.command.hint', { name: '/model' }));
    const listed = renderToText(view('idle'), { text: '/mo', commands: COMMANDS });
    expect(listed).toContain(t('view.command.list', { names: '/model /exit' }));
    const plain = renderToText(view('idle'), { text: 'hello', commands: COMMANDS });
    expect(plain).not.toContain(t('view.command.list', { names: '/model /exit' }));
    expect(renderToText(view('idle'), { focused: false })).toContain(
      `   ${t('view.input.placeholder')}`,
    );
  });

  test('the transcript draws each kind of entry in its own way', () => {
    const frame = renderToText(
      view(
        'working',
        { kind: 'user', id: 'u', text: 'Where is my order?' },
        { kind: 'tool', id: 't1', name: 'lookup_order', done: true, ok: true, durationMs: 420 },
        { kind: 'tool', id: 't2', name: 'policy', done: true, ok: true, durationMs: 1234 },
        { kind: 'tool', id: 't3', name: 'refund', done: true, ok: false, durationMs: 30_000 },
        { kind: 'tool', id: 't4', name: 'slow', done: false, ok: true, durationMs: null },
        { kind: 'tool', id: 't5', name: 'untimed', done: true, ok: true, durationMs: null },
        { kind: 'agent', id: 'a', text: 'It ships', streaming: true, a2ui: [] },
        { kind: 'agent', id: 'b', text: '', streaming: true, a2ui: [] },
        { kind: 'ask', id: 'q', text: 'Refund or credit?' },
        { kind: 'note', id: 'n', text: 'Model set to gpt-6.1-sol.' },
      ),
    );
    expect(frame).toContain('you   Where is my order?');
    expect(frame).toContain('      ✓ lookup_order 420 ms');
    expect(frame).toContain('      ✓ policy 1.2 s');
    expect(frame).toContain('      ✗ refund failed');
    expect(frame).toContain('      ⠿ slow running');
    expect(frame).toContain('agent It ships▍');
    expect(frame).toContain('agent ┃ Needs your input\n      ┃ Refund or credit?');
    expect(frame).toContain('      Model set to gpt-6.1-sol.');
    expect(formatDuration(999.6)).toBe('1000 ms');
  });

  test('an A2UI form is drawn with every control, and the focus is marked', () => {
    const frame = renderToText(view('awaiting-next-interaction', form()));
    for (const text of [
      'A2UI',
      'Refund details',
      '  What happened?',
      '  (*) Arrived damaged',
      '  ( ) Never arrived',
      '  [ ] I can send a photo of the damage',
      '  Notes: anything else',
      '  Amount ◀ 20 ▶ (0–100)',
      '  Delivered on:',
      '  [ Submit ]',
      '  [ Skip ]',
      '[ Policy ]',
      'Refunds within 30 days.',
      '  [ Icon help ]',
      'Image: https://example.com/lamp.png',
      'Video: https://example.com/lamp.mp4',
      'Audio: https://example.com/lamp.mp3',
      t('tui.a2ui.hint'),
    ]) {
      expect(frame).toContain(text);
    }
    const focusOn = (controlId: string, cursor = 0): string =>
      renderToText(view('awaiting-next-interaction', form()), {
        focused: false,
        focus: { itemId: 'a', surfaceId: 'main', controlId, cursor },
      });
    expect(focusOn('reason', 2)).toContain('> ( ) Never arrived');
    expect(focusOn('photo')).toContain('> [ ] I can send a photo of the damage');
    expect(focusOn('notes')).toContain('> Notes: ▍');
    expect(focusOn('amount')).toContain('> Amount ◀ 20 ▶');
    expect(focusOn('submit')).toContain('> [ Submit ]');
    expect(focusOn('submit')).toContain('  [ Skip ]');
    const elsewhere = renderToText(view('awaiting-next-interaction', form()), {
      focus: { itemId: 'other', surfaceId: 'main', controlId: 'submit', cursor: 0 },
    });
    expect(elsewhere).toContain('  [ Submit ]');
  });

  test('what cannot be drawn is named in a fallback line, and nothing of it is shown', () => {
    const frame = renderToText(
      view('awaiting-next-interaction', form([hostileSurface(), 'garbage', [{ no: 'version' }]])),
    );
    expect(frame).toContain(t('view.a2ui.fallback', { component: 'ScriptTag' }));
    expect(frame).not.toContain('alert(1)');
    const malformed = t('view.a2ui.fallback', { component: t('tui.a2ui.message') });
    expect(frame.split(malformed).length - 1).toBe(2);
    expect(frame).not.toContain(t('tui.a2ui.hint'));
  });

  test('the entities describe a text and voice surface that draws the basic catalog', () => {
    expect(tuiRenderer.ref).toEqual({ kind: 'renderer', id: 'tui', version: null });
    expect(tuiRenderer.a2uiCatalogs).toEqual([
      'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
    ]);
    expect(tuiSurface.ref).toEqual({ kind: 'surface', id: 'tui', version: null });
    expect(tuiSurface.renderer).toBe(tuiRenderer);
    expect(tuiSurface.modalities).toEqual(['text', 'audio']);
  });

  test('plain mode is chosen without a terminal or with NO_COLOR', () => {
    expect(isPlain(new FakeDisplay(true), {})).toBe(false);
    expect(isPlain(new FakeDisplay(true), { NO_COLOR: '' })).toBe(false);
    expect(isPlain(new FakeDisplay(true), { NO_COLOR: '1' })).toBe(true);
    expect(isPlain(new FakeDisplay(false), {})).toBe(true);
    expect(isPlain(new PassThrough(), {})).toBe(true);
  });
});

describe('plain-line mode', () => {
  const twoButtons: unknown[] = [
    ...refundForm(),
    [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'bad',
          catalogId: BASIC_CATALOG_ID,
          components: [
            { id: 'root', component: 'Column', children: ['x'] },
            { id: 'x', component: 'ScriptTag' },
          ],
        },
      },
    ],
    'garbage',
  ];

  function start(views: readonly TaskView[], overrides: Partial<TuiSession> = {}) {
    const sent: unknown[] = [];
    const queue = [...views];
    const session: TuiSession = {
      commands: [],
      dashboardUrl: null,
      // oxlint-disable-next-line typescript/require-await -- an async generator by contract
      send: async function* send(input) {
        sent.push(input);
        const next = queue.shift();
        if (next !== undefined) {
          yield { ...next, state: 'working' };
          yield next;
        }
      },
      complete: (current) => Promise.resolve({ ...current, state: 'completed' }),
      cancel: (current) => Promise.resolve({ ...current, state: 'canceled' }),
      ...overrides,
    };
    const controller = new TuiController(session);
    const keyboard = new PassThrough();
    const display = new FakeDisplay(false);
    const done = runPlain(controller, keyboard, display);
    /** Enters a line and waits until `expected` is printed after it. */
    const line = async (text: string, expected: string): Promise<void> => {
      const from = display.raw.length;
      keyboard.write(`${text}\n`);
      await waitFor(
        () => display.raw.slice(from).includes(expected),
        () => display.raw,
      );
    };
    return { sent, controller, keyboard, display, done, line };
  }

  test('prints each entry once, as one line, and ends with the input', async () => {
    const shown = view(
      'awaiting-user-input',
      { kind: 'user', id: 'u', text: 'hi' },
      { kind: 'tool', id: 't1', name: 'lookup', done: true, ok: true, durationMs: null },
      { kind: 'tool', id: 't2', name: 'refund', done: true, ok: false, durationMs: 5 },
      { kind: 'tool', id: 't3', name: 'slow', done: false, ok: true, durationMs: null },
      { kind: 'agent', id: 'a', text: 'still writing', streaming: true, a2ui: [] },
      { kind: 'agent', id: 'b', text: '', streaming: false, a2ui: [] },
      { kind: 'ask', id: 'q', text: 'Refund or credit\u0007?' },
    );
    const ui = start([shown, shown]);
    await ui.line('hi', '[needs your input]\n');
    await ui.line('/temporal', t('tui.temporal.none'));
    await ui.line('again', '[needs your input]\n');
    ui.keyboard.end();
    await ui.done;
    expect(ui.controller.getState().exited).toBe(true);
    expect(ui.display.raw).toBe(
      [
        t('tui.plain.hint'),
        '[working]',
        'tool: lookup ok',
        'tool: refund failed',
        'agent: [needs your input] Refund or credit?',
        '[needs your input]',
        `note: ${t('tui.temporal.none')}`,
        '[working]',
        '[needs your input]',
        '',
      ].join('\n'),
    );
  });

  test('a form with several buttons asks which one; answers that do not fit are sent as text', async () => {
    const shown = view('awaiting-next-interaction', form(twoButtons));
    const ui = start([shown, shown, shown]);
    await ui.line('refund please', 'answer as: 1,n,-,20,-,1\n');
    expect(ui.display.raw).toContain('agent: [form] Refund details\n');
    expect(ui.display.raw).toContain(`  ${t('view.a2ui.fallback', { component: 'ScriptTag' })}\n`);
    expect(ui.display.raw).toContain(
      `  ${t('view.a2ui.fallback', { component: t('tui.a2ui.message') })}\n`,
    );
    expect(ui.display.raw).toContain('  4. Amount (0-100)\n');
    expect(ui.display.raw).toContain('  3. Notes (text)\n');
    expect(ui.display.raw).toContain('  6. Choose (1) Submit (2) Skip (3) Icon help\n');

    for (const wrong of [
      '9,n,-,20,-,1',
      '1,maybe,-,20,-,1',
      '1,n,-,500,-,1',
      '1,n,-,,-,1',
      '1,n,-,20,-,7',
      '1,n',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one line after the other
      await ui.line(wrong, '[waiting for you]');
    }
    await waitFor(
      () => ui.sent.length === 7,
      () => JSON.stringify(ui.sent),
    );
    expect(ui.sent.slice(1).every((input) => JSON.stringify(input).includes('"text":"'))).toBe(
      true,
    );
    expect(JSON.stringify(ui.sent)).not.toContain('a2uiAction');

    ui.keyboard.write('3,YES,crushed box,35,2026-11-09,1\n');
    await waitFor(
      () => ui.sent.length === 8,
      () => JSON.stringify(ui.sent),
    );
    expect(ui.sent[7]).toMatchObject({
      text: '',
      a2uiAction: {
        action: {
          name: 'submitRefund',
          context: { reason: ['missing'], photo: true, notes: 'crushed box' },
        },
      },
    });
    await ui.line('/cancel', '[canceled]\n');
    ui.keyboard.write('/exit\n');
    await ui.done;
  });

  test('a button without an action sends the line as text', async () => {
    const inert = [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          catalogId: BASIC_CATALOG_ID,
          components: [{ id: 'root', component: 'CheckBox', label: 'Agree', value: true }],
        },
      },
    ];
    const shown = view('awaiting-next-interaction', form([inert]));
    const ui = start([shown, shown]);
    await ui.line('show', '[waiting for you] answer as: y\n');
    expect(ui.display.raw).toContain('  1. Agree (y/n)\n');
    await ui.line('n', '[waiting for you] answer as: y\n');
    expect(ui.sent).toEqual([{ text: 'show' }, { text: 'n' }]);
    await ui.line('/complete', '[completed]\n');
    ui.keyboard.end();
    await ui.done;
  });
});
