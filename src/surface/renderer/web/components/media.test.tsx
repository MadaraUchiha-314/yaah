import { describe, expect, test } from 'bun:test';

import {
  Composer,
  FileBlock,
  Transcript,
  act,
  fireEvent,
  render,
  waitFor,
  webTest,
} from '../../../../../test/web/index.ts';
import { t } from '../../../../kernel/strings.ts';
import { SAMPLE_IMAGE } from '../../../../testing/renderer-contract.ts';
import type { TurnFile } from '../../../session.ts';
import type { FileItem } from '../../../view-files.ts';
import { EMPTY_VIEW } from '../../../view.ts';
import { MicError } from '../lib/recorder.ts';
import type { Recording } from '../lib/recorder.ts';

webTest();

interface Sent {
  readonly text: string;
  readonly files: readonly TurnFile[];
}

function png(name: string): File {
  return new File([Uint8Array.from([137, 80, 78, 71])], name, { type: 'image/png' });
}

function composer(
  options: { busy?: boolean; record?: () => Promise<Recording>; speak?: boolean } = {},
) {
  const sent: Sent[] = [];
  const toggled: boolean[] = [];
  const drawn = render(
    <Composer
      state="idle"
      commands={[]}
      busy={options.busy ?? false}
      record={options.record}
      speak={
        options.speak === undefined
          ? undefined
          : {
              on: options.speak,
              onToggle: () => {
                toggled.push(true);
              },
            }
      }
      onSend={(text, files = []) => {
        sent.push({ text, files });
      }}
    />,
  );
  const { container } = drawn;
  const one = (selector: string): HTMLElement => {
    const found = container.querySelector<HTMLElement>(selector);
    if (found === null) {
      throw new Error(`Nothing matches ${selector}.`);
    }
    return found;
  };
  return {
    ...drawn,
    sent,
    toggled,
    one,
    field: one('textarea'),
    picker: one('[data-slot="attach-input"]'),
    mic: one('[data-slot="mic"]'),
    thumbnails: () => [...container.querySelectorAll('[data-slot="attachment"] img')],
    problem: () => container.querySelector('[data-slot="mic-problem"]')?.textContent ?? '',
  };
}

const VOICE: TurnFile = {
  mediaType: 'audio/webm',
  name: 'voice-message.webm',
  data: Uint8Array.from([1, 2, 3]),
};

/** A microphone that works: every recording stops into {@link VOICE}. */
function workingMic(): { record: () => Promise<Recording>; canceled: number[] } {
  const canceled: number[] = [];
  return {
    canceled,
    record: () =>
      Promise.resolve({
        stop: () => Promise.resolve(VOICE),
        cancel: () => {
          canceled.push(1);
        },
      }),
  };
}

describe('Composer: attaching images', () => {
  /**
   * Feature: Web renderer
   * Scenario: An image is attached, shown as a thumbnail, and sent with the message
   *   Given the composer
   *   When the user picks an image file
   *   Then a thumbnail of it appears before anything is sent
   *   And sending delivers the text together with the image, and clears both
   * Requirement: docs/specs/issue-3/requirements.md R24.1
   */
  test('An image is attached, shown as a thumbnail, and sent with the message', async () => {
    const ui = composer();
    const clicks: string[] = [];
    ui.picker.addEventListener('click', () => {
      clicks.push('picker');
    });
    fireEvent.click(ui.one('[data-slot="attach"]'));
    expect(clicks).toEqual(['picker']);
    fireEvent.change(ui.picker, {
      target: { files: [png('lamp.png'), new File(['x'], 'notes.txt')] },
    });
    await waitFor(() => {
      expect(ui.thumbnails().length).toBe(1);
    });
    const [thumbnail] = ui.thumbnails();
    expect(thumbnail?.getAttribute('alt')).toBe('lamp.png');
    expect(thumbnail?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    expect(ui.sent).toEqual([]);

    fireEvent.change(ui.field, { target: { value: 'What is this?' } });
    fireEvent.keyDown(ui.field, { key: 'Enter' });
    expect(ui.sent.length).toBe(1);
    expect(ui.sent[0]?.text).toBe('What is this?');
    expect(ui.sent[0]?.files.map((file) => [file.mediaType, file.name, [...file.data]])).toEqual([
      ['image/png', 'lamp.png', [137, 80, 78, 71]],
    ]);
    expect(ui.thumbnails().length).toBe(0);
    expect(ui.field instanceof HTMLTextAreaElement ? ui.field.value : null).toBe('');
  });

  test('an image can be sent on its own, and removed before sending', async () => {
    const ui = composer();
    fireEvent.change(ui.picker, { target: { files: [png('a.png'), png('b.png')] } });
    await waitFor(() => {
      expect(ui.thumbnails().length).toBe(2);
    });
    fireEvent.click(ui.one(`button[aria-label="${t('web.attach.remove', { name: 'a.png' })}"]`));
    expect(ui.thumbnails().map((image) => image.getAttribute('alt'))).toEqual(['b.png']);
    fireEvent.submit(ui.one('form'));
    expect(ui.sent.map((turn) => [turn.text, turn.files.length])).toEqual([['', 1]]);
  });

  test('an image pasted into the input is attached; pasted text is left to the input', async () => {
    const ui = composer();
    fireEvent.paste(ui.field, { clipboardData: { files: [] } });
    expect(ui.thumbnails().length).toBe(0);
    fireEvent.paste(ui.field, { clipboardData: { files: [png('')] } });
    await waitFor(() => {
      expect(ui.thumbnails().length).toBe(1);
    });
    expect(ui.thumbnails()[0]?.getAttribute('alt')).toBe(t('view.file.image'));
  });

  test('nothing can be attached or recorded while a turn is in flight', () => {
    const ui = composer({ busy: true });
    expect(ui.one('[data-slot="attach"]').hasAttribute('disabled')).toBe(true);
    expect(ui.mic.hasAttribute('disabled')).toBe(true);
  });
});

describe('Composer: voice', () => {
  /**
   * Feature: Web renderer
   * Scenario: The microphone button records and submits the recording as the user's turn
   *   Given the composer and a working microphone
   *   When the user presses the microphone button, and presses it again
   *   Then the first press starts a recording and says so
   *   And the second press sends the recording as a turn with no text
   * Requirement: docs/specs/issue-3/requirements.md R24.4
   */
  test("The microphone button records and submits the recording as the user's turn", async () => {
    const ui = composer({ record: workingMic().record });
    expect(ui.mic.getAttribute('aria-label')).toBe(t('web.voice.start'));
    fireEvent.click(ui.mic);
    await waitFor(() => {
      expect(ui.mic.getAttribute('aria-pressed')).toBe('true');
    });
    expect(ui.mic.getAttribute('aria-label')).toBe(t('web.voice.stop'));
    expect(ui.field.getAttribute('placeholder')).toBe(t('web.voice.recording'));
    fireEvent.click(ui.mic);
    await waitFor(() => {
      expect(ui.sent.length).toBe(1);
    });
    expect(ui.sent[0]).toEqual({ text: '', files: [VOICE] });
    expect(ui.mic.getAttribute('aria-pressed')).toBe('false');
    expect(ui.problem()).toBe('');
  });

  /**
   * Feature: Web renderer
   * Scenario: A denied or missing microphone is said in words and text input still works
   *   Given a browser that denies the microphone, or has none
   *   When the user presses the microphone button
   *   Then the page says which it is
   *   And a typed message is sent as before
   * Requirement: docs/specs/issue-3/requirements.md R24.6
   */
  test('A denied or missing microphone is said in words and text input still works', async () => {
    for (const problem of ['denied', 'unavailable', 'failed'] as const) {
      const ui = composer({ record: () => Promise.reject(new MicError(problem)) });
      fireEvent.click(ui.mic);
      // oxlint-disable-next-line no-await-in-loop -- one composer at a time
      await waitFor(() => {
        expect(ui.problem()).toBe(t(`web.voice.problem.${problem}`));
      });
      expect(ui.one('[data-slot="mic-problem"]').getAttribute('role')).toBe('alert');
      expect(ui.mic.getAttribute('aria-pressed')).toBe('false');
      fireEvent.change(ui.field, { target: { value: 'Typed instead' } });
      fireEvent.keyDown(ui.field, { key: 'Enter' });
      expect(ui.sent.map((turn) => turn.text)).toEqual(['Typed instead']);
      ui.unmount();
    }
  });

  test('an error that is not about the microphone, and a recording that breaks, are failures', async () => {
    const broken = composer({ record: () => Promise.reject(new Error('odd')) });
    fireEvent.click(broken.mic);
    await waitFor(() => {
      expect(broken.problem()).toBe(t('web.voice.problem.failed'));
    });
    broken.unmount();

    const cut = composer({
      record: () =>
        Promise.resolve({
          stop: () => Promise.reject(new MicError('failed')),
          cancel: () => undefined,
        }),
    });
    fireEvent.click(cut.mic);
    await waitFor(() => {
      expect(cut.mic.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(cut.mic);
    await waitFor(() => {
      expect(cut.problem()).toBe(t('web.voice.problem.failed'));
    });
    expect(cut.sent).toEqual([]);
  });

  test('a recording still under way when the page goes is dropped, not sent', async () => {
    const mic = workingMic();
    const ui = composer({ record: mic.record });
    fireEvent.click(ui.mic);
    await waitFor(() => {
      expect(ui.mic.getAttribute('aria-pressed')).toBe('true');
    });
    // A second press while the first is still being set up is ignored.
    await act(async () => {
      await Promise.resolve();
    });
    ui.unmount();
    expect(mic.canceled).toEqual([1]);
    expect(ui.sent).toEqual([]);
  });

  test('the spoken-answers switch is drawn when offered, says its state, and toggles', () => {
    const off = composer({ speak: false });
    const toggle = off.one('[data-slot="speak-toggle"]');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe(t('web.speak.off'));
    fireEvent.click(toggle);
    expect(off.toggled).toEqual([true]);
    off.unmount();
    const on = composer({ speak: true });
    expect(on.one('[data-slot="speak-toggle"]').getAttribute('aria-label')).toBe(t('web.speak.on'));
  });
});

describe('files in the conversation', () => {
  const file = (change: Partial<FileItem>): FileItem => ({
    kind: 'file',
    id: 'artifact-1/0',
    from: 'agent',
    mediaType: 'image/png',
    name: 'lamp.png',
    url: SAMPLE_IMAGE,
    ...change,
  });

  /**
   * Feature: Web renderer
   * Scenario: An image artifact is drawn from inline data or https, and from nothing else
   *   Given images whose address is inline image data, an https link, and three unsafe ones
   *   When each is drawn
   *   Then the first two are images with their name as alternative text
   *   And the others are named but never loaded, and a link is offered only to https
   * Requirement: docs/specs/issue-3/requirements.md R24.2, abuse case 5
   */
  test('An image artifact is drawn from inline data or https, and from nothing else', () => {
    const inline = render(<FileBlock item={file({})} />);
    const image = inline.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(SAMPLE_IMAGE);
    expect(image?.getAttribute('alt')).toBe('lamp.png');
    expect(inline.container.textContent).toContain(t('view.file.image'));
    inline.unmount();

    const linked = render(
      <FileBlock item={file({ url: 'https://img.example/lamp.png', name: '' })} />,
    );
    expect(linked.container.querySelector('img')?.getAttribute('alt')).toBe(t('view.file.image'));
    expect(linked.container.querySelector('a')).toBeNull();
    linked.unmount();

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'http://img.example/a.png',
      null,
    ]) {
      const unsafe = render(<FileBlock item={file({ url })} />);
      expect(unsafe.container.querySelector('img')).toBeNull();
      expect(unsafe.container.querySelector('a')).toBeNull();
      expect(unsafe.container.textContent).toContain('lamp.png');
      expect(unsafe.container.textContent).toContain(t('web.file.hidden'));
      unsafe.unmount();
    }
  });

  test('a voice message and any other file are named; another file links only to https', () => {
    const voice = render(
      <FileBlock item={file({ from: 'user', mediaType: 'audio/webm', name: '', url: null })} />,
    );
    expect(voice.container.textContent).toBe(t('view.file.voice'));
    expect(voice.container.querySelector('figure')?.dataset['from']).toBe('user');
    voice.unmount();

    const pdf = render(
      <FileBlock
        item={file({
          mediaType: 'application/pdf',
          name: 'terms.pdf',
          url: 'https://x.example/t.pdf',
        })}
      />,
    );
    expect(pdf.container.textContent).toContain(t('view.file.other'));
    const link = pdf.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://x.example/t.pdf');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    pdf.unmount();

    const spoken = render(<FileBlock item={file({ mediaType: 'audio/wav', url: null })} />);
    expect(spoken.container.textContent).toContain(t('view.file.audio'));
  });

  test('the transcript puts the image a user sent on its own and the one an agent made inside its turn', () => {
    const view = {
      ...EMPTY_VIEW,
      taskId: 't1',
      state: 'awaiting-next-interaction' as const,
      items: [
        { kind: 'user' as const, id: 'u1', text: 'Draw a lamp like this' },
        file({ id: 'u1/1', from: 'user', name: 'sketch.png' }),
        { kind: 'agent' as const, id: 'a1', text: 'Here it is.', streaming: false, a2ui: [] },
        file({ id: 'artifact-1/0' }),
      ],
    };
    const { container } = render(
      <Transcript view={view} commands={[]} onAction={() => undefined} />,
    );
    const images = [...container.querySelectorAll<HTMLElement>('[data-slot="image"]')];
    expect(images.map((image) => image.dataset['from'])).toEqual(['user', 'agent']);
    expect(images[0]?.closest('[data-slot="agent-turn"]')).toBeNull();
    expect(images[1]?.closest('[data-slot="agent-turn"]') === null).toBe(false);
  });
});
