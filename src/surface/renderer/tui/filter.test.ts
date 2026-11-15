import { describe, expect, test } from 'bun:test';

import { EMPTY_VIEW } from '../../view.ts';
import { sanitize, sanitizeDeep, sanitizeView } from './filter.ts';

const ESC = '\u001B';
const BEL = '\u0007';

describe('terminal output filter', () => {
  test('removes an OSC sequence that sets the window title, payload included', () => {
    expect(sanitize(`before${ESC}]0;owned${BEL}after`)).toBe('beforeafter');
    expect(sanitize(`before${ESC}]2;owned${ESC}\\after`)).toBe('beforeafter');
    expect(sanitize('before\u009D0;owned\u009Cafter')).toBe('beforeafter');
  });

  test('removes cursor movement and screen clearing', () => {
    expect(sanitize(`a${ESC}[2Jb${ESC}[Hc${ESC}[10;20Hd${ESC}[1Ae${ESC}[?25lf`)).toBe('abcdef');
    expect(sanitize('a\u009B2Jb')).toBe('ab');
    expect(sanitize(`a${ESC}cb${ESC}7c${ESC}(0d`)).toBe('abcd');
  });

  test('removes a hyperlink sequence and keeps the visible text', () => {
    const link = `${ESC}]8;;https://evil.example${ESC}\\click here${ESC}]8;;${ESC}\\`;
    expect(sanitize(link)).toBe('click here');
  });

  test('removes colour codes, device control strings and bare control characters', () => {
    expect(sanitize(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitize(`a${ESC}Pq#0;2;0;0;0${ESC}\\b`)).toBe('ab');
    expect(sanitize(`a${BEL}b\u0008c\u007Fd\u0085e\u0000f`)).toBe('abcdef');
  });

  test('leaves no escape behind when a sequence is cut short', () => {
    const cleaned = sanitize(`a${ESC}]0;never closed`) + sanitize(`b${ESC}`) + sanitize(`${ESC}[`);
    expect(cleaned.includes(ESC)).toBe(false);
    expect(cleaned).toContain('never closed');
  });

  test('removes bidi controls, zero-width spaces, separators and the byte-order mark', () => {
    const formats = [
      '\u202E',
      '\u202A',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u200B',
      '\u200E',
      '\u200F',
      '\u2028',
      '\u2029',
      '\uFEFF',
      '\u061C',
      '\u2060',
      '\u2061',
      '\u2064',
    ];
    for (const format of formats) {
      expect(sanitize(`a${format}b\n\tc`)).toBe('ab\n\tc');
    }
    expect(sanitize('invoice\u202Etxt.exe')).toBe('invoicetxt.exe');
    // The joiners stay: an emoji sequence is one picture, not three.
    expect(sanitize('👩\u200D💻')).toBe('👩\u200D💻');
  });

  test('keeps newlines, tabs and ordinary text, and drops carriage returns', () => {
    expect(sanitize('one\n\ttwo — ünïcödé ✓')).toBe('one\n\ttwo — ünïcödé ✓');
    expect(sanitize('one\r\ntwo\rthree')).toBe('one\ntwothree');
  });

  test('filters every string inside a JSON value, keys included', () => {
    const cleaned = sanitizeDeep({ [`k${BEL}`]: [`v${ESC}[2J`, 3, null, { deep: `x${ESC}c` }] });
    expect(cleaned).toEqual({ k: ['v', 3, null, { deep: 'x' }] });
  });

  test('filters the text, tool names and address of a view', () => {
    const view = sanitizeView({
      ...EMPTY_VIEW,
      workflowUrl: `http://temporal${ESC}[2J`,
      items: [
        { kind: 'user', id: 'u', text: `hi${BEL}` },
        { kind: 'agent', id: 'a', text: `yo${ESC}[H`, streaming: false, a2ui: [] },
        { kind: 'tool', id: 't', name: `tool${ESC}c`, done: true, ok: true, durationMs: 1 },
      ],
    });
    expect(view.workflowUrl).toBe('http://temporal');
    expect(JSON.stringify(view.items).includes('\\u001b')).toBe(false);
    expect(view.items.map((item) => ('text' in item ? item.text : item.name))).toEqual([
      'hi',
      'yo',
      'tool',
    ]);
    expect(sanitizeView(EMPTY_VIEW).workflowUrl).toBeNull();
  });
});
