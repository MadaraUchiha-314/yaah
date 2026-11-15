/**
 * The output filter of the terminal UI. What an agent, a tool or a remote harness says
 * is data; a terminal, however, obeys escape sequences in whatever it is given — they
 * can retitle the window, move the cursor over earlier output, clear the screen, or
 * disguise a link. Everything from a view passes through {@link sanitize} before it is
 * drawn or printed.
 */
import type { TaskView, TranscriptItem } from '../../view.ts';

const ESC = '\\u001B';
const ST = `(?:\\u0007|${ESC}\\\\|\\u009C)`;

/** Whole escape sequences, longest forms first, so their payload goes with them. */
const SEQUENCES = new RegExp(
  [
    // OSC (window title, hyperlinks, clipboard), terminated by BEL or ST.
    `(?:${ESC}\\]|\\u009D)[^\\u0007\\u001B\\u009C]*${ST}`,
    // DCS, SOS, PM, APC: a string up to ST.
    `(?:${ESC}[PX^_]|[\\u0090\\u0098\\u009E\\u009F])[^\\u001B\\u009C]*${ST}`,
    // CSI (cursor movement, erasing, colours): parameters, intermediates, a final byte.
    `(?:${ESC}\\[|\\u009B)[0-?]*[ -/]*[@-~]`,
    // Any other escape: intermediates and one final byte.
    `${ESC}[ -/]*[0-~]`,
  ].join('|'),
  'gu',
);

/** Every C0 and C1 control character left over, and DEL — but not newline or tab. */
// oxlint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/**
 * Removes terminal control from a string: escape sequences (CSI, OSC, DCS and the
 * rest) together with their payload, then every remaining C0/C1 control character.
 *
 * Invariant: the result contains no character below U+0020 except newline and tab, no
 * DEL and no C1 control — so no byte of it can start or continue an escape sequence.
 */
export function sanitize(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll(SEQUENCES, '').replaceAll(CONTROLS, '');
}

/**
 * Applies {@link sanitize} to every string inside a JSON-like value — keys and values —
 * and returns a copy. Used on A2UI messages before they are interpreted.
 */
export function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitize(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => sanitizeDeep(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]: [string, unknown]) => [
        sanitize(key),
        sanitizeDeep(entry),
      ]),
    );
  }
  return value;
}

function sanitizeItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === 'tool') {
    return { ...item, name: sanitize(item.name) };
  }
  if (item.kind === 'file') {
    return {
      ...item,
      id: sanitize(item.id),
      name: sanitize(item.name),
      mediaType: sanitize(item.mediaType),
      url: item.url === null ? null : sanitize(item.url),
    };
  }
  return { ...item, text: sanitize(item.text) };
}

/**
 * The view as it may be shown: every string of its transcript filtered. Item ids are
 * kept as they are — they are keys, never drawn — and so are A2UI batches, which the
 * A2UI model filters with {@link sanitizeDeep} when it reads them.
 */
export function sanitizeView(view: TaskView): TaskView {
  return {
    ...view,
    workflowUrl: view.workflowUrl === null ? null : sanitize(view.workflowUrl),
    items: view.items.map((item) => sanitizeItem(item)),
  };
}
