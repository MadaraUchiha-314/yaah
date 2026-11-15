import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { ActionMessage } from '../../../../../test/web/index.ts';
import {
  A2uiBlock,
  A2uiStage,
  KNOWN_COMPONENTS,
  SurfaceBoundary,
  act,
  fireEvent,
  nameControls,
  render,
  watchControls,
  webCatalog,
  webTest,
} from '../../../../../test/web/index.ts';
import { t } from '../../../../kernel/strings.ts';
import { sampleSurface } from '../../../../testing/renderer-contract.ts';
import { BASIC_CATALOG_ID } from '../index.ts';

webTest();

/** One batch that creates a surface from `components`. */
function surface(surfaceId: string, components: unknown[], dataModel: unknown = {}): unknown[] {
  return [
    {
      version: '1.0',
      createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID, components, dataModel },
    },
  ];
}

/** Lets the A2UI custom elements, which render in a microtask, finish. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });
}

async function draw(batches: readonly unknown[], onAction: (message: ActionMessage) => void) {
  const drawn = render(<A2uiBlock batches={batches} onAction={onAction} />);
  await settled();
  return drawn;
}

const ignore = (): void => undefined;
const fallback = (component: string): string => t('view.a2ui.fallback', { component });

describe('the web catalog', () => {
  test('is the basic catalog by id and by component names', () => {
    expect(webCatalog.id).toBe(BASIC_CATALOG_ID);
    expect(KNOWN_COMPONENTS.has('ChoicePicker')).toBe(true);
    expect(KNOWN_COMPONENTS.size).toBe(18);
    expect(webCatalog.functions.has('openUrl')).toBe(true);
  });
});

describe('A2uiStage', () => {
  test('feeds batches once, in order, and starts over when they no longer extend', () => {
    const stage = new A2uiStage(ignore);
    const first = sampleSurface();
    const second = surface('other', [{ id: 'root', component: 'Text', text: 'Second' }]);
    expect(stage.feed([]).surfaces).toEqual([]);
    expect(stage.feed([first]).surfaces.map((model) => model.id)).toEqual(['main']);
    // The same batches again create nothing twice.
    expect(stage.feed([first]).surfaces.map((model) => model.id)).toEqual(['main']);
    expect(stage.feed([first, second]).surfaces.map((model) => model.id)).toEqual([
      'main',
      'other',
    ]);
    // A different history: the stage is rebuilt from it.
    expect(stage.feed([second]).surfaces.map((model) => model.id)).toEqual(['other']);
    stage.dispose();
    expect(stage.feed([]).surfaces).toEqual([]);
  });

  test('refuses a batch with an unknown component, a malformed one, and one the processor rejects', () => {
    const stage = new A2uiStage(ignore);
    const unknown = surface('bad', [{ id: 'root', component: 'ScriptTag', code: 'alert(1)' }]);
    const twice = [...sampleSurface(), ...sampleSurface()];
    const snapshot = stage.feed([unknown, 'garbage', twice]);
    expect(snapshot.refused).toEqual([
      'ScriptTag',
      t('web.a2ui.malformed'),
      t('web.a2ui.malformed'),
    ]);
    expect(snapshot.surfaces.map((model) => model.id)).toEqual(['main']);
  });
});

describe('A2uiBlock', () => {
  /**
   * Feature: Surfaces and renderers
   * Scenario: A user action on a surface is returned as an A2UI 1.0 action message
   *   Given a basic-catalog surface with a button
   *   When the user presses the button
   *   Then the block reports { version: "1.0", action } naming the event and the surface
   * Requirement: docs/specs/issue-3/requirements.md R19.4
   */
  test('A user action on a surface is returned as an A2UI 1.0 action message', async () => {
    const actions: ActionMessage[] = [];
    const { container } = await draw([sampleSurface()], (message) => {
      actions.push(message);
    });
    expect(container.textContent).toContain('Refund details');
    const button = container.querySelector('button');
    expect(button?.textContent).toContain('Submit refund');
    if (button !== null) {
      fireEvent.click(button);
    }
    await settled();
    expect(actions.length).toBe(1);
    expect(actions[0]?.version).toBe('1.0');
    expect(actions[0]?.action.name).toBe('submitRefund');
    expect(actions[0]?.action.surfaceId).toBe('main');
    expect(actions[0]?.action.sourceComponentId).toBe('submit');
  });

  test('draws nothing for an answer without A2UI', async () => {
    const { container } = await draw([], ignore);
    expect(container.innerHTML).toBe('');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A surface the catalog cannot draw becomes a line of text
   *   Given a batch with a component the basic catalog does not have, and a valid batch
   *   When they are drawn
   *   Then the valid surface is drawn, a fallback line names the unknown component
   *   And nothing the hostile component carried is on the page
   * Requirement: docs/specs/issue-3/requirements.md R19.5; abuse case 5
   */
  test('A surface the catalog cannot draw becomes a line of text', async () => {
    const hostile = surface('bad', [{ id: 'root', component: 'ScriptTag', code: 'alert(1)' }]);
    const { container } = await draw([hostile, sampleSurface(), { not: 'a batch' }], ignore);
    expect(container.textContent).toContain(fallback('ScriptTag'));
    expect(container.textContent).toContain(fallback(t('web.a2ui.malformed')));
    expect(container.textContent).toContain('Refund details');
    expect(container.textContent).not.toContain('alert(1)');
    expect(container.querySelectorAll('[data-slot="a2ui"]').length).toBe(1);
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: Media is loaded from https only, and images also from inline data
   *   Given a surface with images, a video and an audio player from allowed and other sources
   *   When it is drawn
   *   Then only the allowed sources reach the page; the others are fallback lines
   * Requirement: docs/specs/issue-3/requirements.md abuse case 5
   */
  test('Media is loaded from https only, and images also from inline data', async () => {
    const ids = ['ok', 'inline', 'js', 'plain', 'bound', 'video', 'badVideo', 'audio', 'badAudio'];
    const { container } = await draw(
      [
        surface(
          'media',
          [
            { id: 'root', component: 'Column', children: ids },
            { id: 'ok', component: 'Image', url: 'https://example.test/a.png', description: 'A' },
            { id: 'inline', component: 'Image', url: 'data:image/png;base64,AAAA' },
            { id: 'js', component: 'Image', url: 'javascript:alert(1)' },
            { id: 'plain', component: 'Image', url: 'http://example.test/a.png' },
            { id: 'bound', component: 'Image', url: { '@path': '/evil' } },
            { id: 'video', component: 'Video', url: 'https://example.test/v.mp4' },
            { id: 'badVideo', component: 'Video', url: 'data:text/html,<script>alert(1)</script>' },
            { id: 'audio', component: 'AudioPlayer', url: 'https://example.test/a.mp3' },
            { id: 'badAudio', component: 'AudioPlayer', url: 'file:///etc/passwd' },
          ],
          { evil: 'javascript:alert(2)' },
        ),
      ],
      ignore,
    );
    const sources = [...container.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    expect(sources).toEqual(['https://example.test/a.png', 'data:image/png;base64,AAAA']);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('A');
    expect(container.querySelector('video')?.getAttribute('src')).toBe(
      'https://example.test/v.mp4',
    );
    expect(container.querySelectorAll('video').length).toBe(1);
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      'https://example.test/a.mp3',
    );
    expect(container.querySelector('audio')?.getAttribute('aria-label')).toBe('AudioPlayer');
    expect(container.querySelectorAll('audio').length).toBe(1);
    const lines = [...container.querySelectorAll('[data-slot="a2ui-fallback"]')].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      fallback('Image'),
      fallback('Image'),
      fallback('Image'),
      fallback('Video'),
      fallback('AudioPlayer'),
    ]);
    expect(container.innerHTML).not.toContain('javascript:');
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: A surface can open https links only
   *   Given buttons whose action is openUrl with an https, an http and a javascript address
   *   When each is pressed
   *   Then only the https address is opened, in a new tab that cannot reach this page
   * Requirement: docs/specs/issue-3/requirements.md abuse case 5
   */
  test('A surface can open https links only', async () => {
    const opened = mock((..._arguments: unknown[]): null => null);
    const realOpen = window.open;
    window.open = opened;
    const link = (id: string, url: string): unknown[] => [
      {
        id,
        component: 'Button',
        child: `${id}Label`,
        action: { functionCall: { '@call': 'openUrl', args: { url } } },
      },
      { id: `${id}Label`, component: 'Text', text: id },
    ];
    try {
      const { container } = await draw(
        [
          surface('links', [
            { id: 'root', component: 'Column', children: ['good', 'plain', 'script'] },
            ...link('good', 'https://example.test/docs'),
            ...link('plain', 'http://example.test/docs'),
            ...link('script', 'javascript:alert(1)'),
          ]),
        ],
        ignore,
      );
      const buttons = [...container.querySelectorAll('button')];
      expect(buttons.length).toBe(3);
      for (const button of buttons) {
        fireEvent.click(button);
      }
      await settled();
    } finally {
      window.open = realOpen;
    }
    expect(opened.mock.calls).toEqual([
      ['https://example.test/docs', '_blank', 'noopener,noreferrer'],
    ]);
  });

  test('a new batch for the same answer is added without redrawing what is there', async () => {
    const first = sampleSurface();
    const drawn = await draw([first], ignore);
    const before = drawn.container.querySelector('[data-slot="a2ui"]');
    const more = surface('second', [{ id: 'root', component: 'Text', text: 'More' }]);
    drawn.rerender(<A2uiBlock batches={[first, more]} onAction={ignore} />);
    await settled();
    expect(drawn.container.querySelectorAll('[data-slot="a2ui"]').length).toBe(2);
    expect(drawn.container.querySelector('[data-slot="a2ui"]')).toBe(before);
    expect(drawn.container.textContent).toContain('More');
  });
});

describe('SurfaceBoundary', () => {
  test('shows the fallback line when what it holds fails to render', () => {
    const Broken = (): ReactNode => {
      throw new Error('a surface that cannot render');
    };
    const realError = console.error;
    console.error = ignore;
    const { container } = render(
      <SurfaceBoundary name="main">
        <Broken />
      </SurfaceBoundary>,
    );
    console.error = realError;
    expect(container.textContent).toBe(fallback('main'));
  });
});

describe('control names (accessibility repair)', () => {
  const field = (): HTMLElement => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div><label>What happened?</label><input /></div>' +
      '<div><label for="x">Tied</label><input id="x" /></div>' +
      '<div><label>Wrapping <input /></label></div>' +
      '<div><label>Alone</label></div>';
    return host;
  };

  test('a label drawn beside a control names it; labels already tied are left alone', () => {
    const host = field();
    nameControls(host);
    nameControls(host);
    const [loose, tied, wrapped] = [...host.querySelectorAll('input')];
    const label = host.querySelector('label');
    expect(label?.id).toMatch(/^a2ui-label-\d+$/u);
    expect(loose?.getAttribute('aria-labelledby')).toBe(label?.id ?? '');
    expect(tied?.hasAttribute('aria-labelledby')).toBe(false);
    expect(wrapped?.hasAttribute('aria-labelledby')).toBe(false);
  });

  test('controls drawn later are named too, until watching stops', async () => {
    const host = document.createElement('div');
    expect(watchControls(null)).toBeUndefined();
    const stop = watchControls(host);
    host.innerHTML = '<div><label>Later</label><textarea></textarea></div>';
    await settled();
    expect(host.querySelector('textarea')?.hasAttribute('aria-labelledby')).toBe(true);
    stop?.();
    host.innerHTML = '<div><label>After</label><select></select></div>';
    await settled();
    expect(host.querySelector('select')?.hasAttribute('aria-labelledby')).toBe(false);
  });

  test('the text field of the basic catalog gets its name from its label', async () => {
    const { container } = await draw(
      [
        surface('form', [
          { id: 'root', component: 'TextField', label: 'What happened?', value: '' },
        ]),
      ],
      ignore,
    );
    const input = container.querySelector('input');
    const label = container.querySelector('label');
    expect(label?.textContent).toBe('What happened?');
    expect(input?.getAttribute('aria-labelledby')).toBe(label?.id ?? 'none');
  });
});
