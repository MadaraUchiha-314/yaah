import { t } from '../kernel/strings.ts';
import type { TaskView, TranscriptItem } from '../surface/view.ts';
import { EMPTY_VIEW } from '../surface/view.ts';
import type { ContractApi } from './contract-api.ts';

/**
 * Draws a view and returns everything a person would read: the visible text of the
 * rendering, with markup, styling and terminal colour codes removed.
 */
export type RenderToText = (view: TaskView) => Promise<string>;

const BASIC = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** A2UI messages that draw a small form with the basic catalog. */
export function sampleSurface(): unknown[] {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: BASIC,
        components: [
          { id: 'root', component: 'Column', children: ['title', 'submit'] },
          { id: 'title', component: 'Text', text: 'Refund details' },
          {
            id: 'submit',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'submitRefund' } },
          },
          { id: 'label', component: 'Text', text: 'Submit refund' },
        ],
      },
    },
  ];
}

function view(state: TaskView['state'], ...items: TranscriptItem[]): TaskView {
  return { ...EMPTY_VIEW, taskId: 't1', contextId: 'c1', state, items };
}

const agent = (text: string, a2ui: unknown[] = []): TranscriptItem => ({
  kind: 'agent',
  id: `a-${text}`,
  text,
  streaming: false,
  a2ui,
});

/**
 * The contract every renderer must keep, whatever it draws with. Run it against a
 * renderer of your own with a function that returns the rendering's visible text.
 */
export function rendererContract(api: ContractApi, name: string, render: RenderToText): void {
  const { describe, expect, test } = api;
  describe(`renderer contract: ${name}`, () => {
    test('shows what the user and the agent said, in order', async () => {
      const text = await render(
        view(
          'awaiting-next-interaction',
          { kind: 'user', id: 'u1', text: 'Where is my order?' },
          agent('It ships today.'),
        ),
      );
      expect(text).toContain('Where is my order?');
      expect(text.indexOf('It ships today.') > text.indexOf('Where is my order?')).toBe(true);
    });

    test('names the state of the task in words, for every state', async () => {
      const states: TaskView['state'][] = [
        'working',
        'awaiting-next-interaction',
        'awaiting-user-input',
        'completed',
        'canceled',
        'failed',
      ];
      for (const state of states) {
        // oxlint-disable-next-line no-await-in-loop -- one rendering at a time
        expect(await render(view(state, agent('x')))).toContain(t(`view.state.${state}`));
      }
    });

    test('sets a request for input apart from an ordinary answer, with a label', async () => {
      const text = await render(
        view('awaiting-user-input', { kind: 'ask', id: 'q1', text: 'Refund or store credit?' }),
      );
      expect(text).toContain('Refund or store credit?');
      expect(text).toContain(t('view.ask.label'));
    });

    test('shows a tool call by name, and whether it failed', async () => {
      const tool = (id: string, toolName: string, ok: boolean): TranscriptItem => ({
        kind: 'tool',
        id,
        name: toolName,
        done: true,
        ok,
        durationMs: 420,
      });
      const text = await render(
        view('working', tool('c1', 'lookup_order', true), tool('c2', 'refund', false)),
      );
      expect(text).toContain('lookup_order');
      expect(text).toContain('refund');
      expect(text).toContain(t('view.tool.failed'));
    });

    test('shows the reply of a command', async () => {
      const text = await render(
        view('idle', { kind: 'note', id: 'n1', text: 'Model set to gpt-6.1-sol.' }),
      );
      expect(text).toContain('Model set to gpt-6.1-sol.');
    });

    test('draws a basic-catalog A2UI surface: its text and its button', async () => {
      const text = await render(
        view('awaiting-next-interaction', agent('Please fill this in.', [sampleSurface()])),
      );
      expect(text).toContain('Please fill this in.');
      expect(text).toContain('Refund details');
      expect(text).toContain('Submit refund');
    });

    test('falls back to text for a component it cannot draw, and keeps going', async () => {
      const hostile = [
        {
          version: '1.0',
          createSurface: {
            surfaceId: 'bad',
            catalogId: BASIC,
            components: [{ id: 'root', component: 'ScriptTag', code: 'alert(1)' }],
          },
        },
      ];
      const text = await render(
        view('awaiting-next-interaction', agent('Before.', [hostile]), agent('After.')),
      );
      expect(text).toContain('Before.');
      expect(text).toContain('After.');
      expect(text).not.toContain('alert(1)');
    });

    test('never passes terminal or markup control through from what the agent said', async () => {
      const text = await render(
        view(
          'awaiting-next-interaction',
          agent('safe \u001B]0;owned\u0007\u001B[2J<script>alert(2)</script> text'),
        ),
      );
      expect(text).toContain('safe');
      expect(text.includes('\u001B')).toBe(false);
      expect(text.includes('\u0007')).toBe(false);
    });
  });
}
