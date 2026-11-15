// Type-aware lint reads this file outside tsconfig.json (it is in tsconfig.web.json), so it names its runner types.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import type { TranscriptItem } from '../../../view.ts';
import { inspectBatch, isSafeImage, isSafeLink } from '../a2ui/safety.ts';
import { toBlocks } from './blocks.ts';
import { bufferShim, installBufferShim } from './buffer-shim.ts';
import { hasCommand, readCommand, splitCommand } from './command.ts';
import { formatDuration, plainText } from './text.ts';
import { cn } from './utils.ts';

const COMMANDS: readonly CommandInfo[] = [
  { name: 'model', description: 'm', scope: 'harness' },
  { name: '/effort', description: 'e', scope: 'harness' },
];

describe('text', () => {
  test('removes control characters and keeps tabs and line breaks', () => {
    expect(plainText('a\u001B[2J\u0007b\tc\nd\u009Be\u007F')).toBe('a[2Jb\tc\nde');
  });

  test('removes bidi controls and zero-width format characters, and keeps the joiners', () => {
    const formats = '\u202E\u2066\u2069\u200B\u200F\u2028\u2029\uFEFF\u061C\u2060\u2065';
    expect(plainText(`a${formats}b\tc\nd`)).toBe('ab\tc\nd');
    expect(plainText('👩\u200D💻')).toBe('👩\u200D💻');
  });

  test('writes a duration in milliseconds below a second and in seconds above', () => {
    expect(formatDuration(419.6)).toBe('420 ms');
    expect(formatDuration(1240)).toBe('1.2 s');
  });

  test('joins class names and lets the later Tailwind utility win', () => {
    expect(cn('px-2', false, 'px-4')).toBe('px-4');
  });
});

describe('commands in the input', () => {
  test('a first word that is a listed command is matched, however the harness lists it', () => {
    expect(readCommand('/model gpt', COMMANDS)).toEqual({
      command: '/model',
      hint: '/model is a command and will not be sent to the model.',
    });
    expect(readCommand('/effort', COMMANDS).command).toBe('/effort');
  });

  test('a slash word that is no command lists the commands', () => {
    expect(readCommand('/nope', COMMANDS)).toEqual({
      command: null,
      hint: 'Commands: /model  /effort',
    });
  });

  test('ordinary text, and a command that is not the first word, say nothing', () => {
    expect(readCommand('hello /model', COMMANDS)).toEqual({ command: null, hint: '' });
    expect(readCommand('', COMMANDS)).toEqual({ command: null, hint: '' });
  });

  test('splits the first word from the rest and knows which commands exist', () => {
    expect(splitCommand('/model  x y')).toEqual({ first: '/model', rest: '  x y' });
    expect(hasCommand(COMMANDS, 'effort')).toBe(true);
    expect(hasCommand(COMMANDS, 'exit')).toBe(false);
  });
});

describe('transcript blocks', () => {
  const tool = (id: string): TranscriptItem => ({
    kind: 'tool',
    id,
    name: id,
    done: true,
    ok: true,
    durationMs: 1,
  });
  const agent = (id: string): TranscriptItem => ({
    kind: 'agent',
    id,
    text: id,
    streaming: false,
    a2ui: [],
  });

  test('what the agent did between two user messages is one turn; adjacent tools one group', () => {
    const blocks = toBlocks([
      { kind: 'user', id: 'u1', text: 'hi' },
      tool('c1'),
      tool('c2'),
      agent('a1'),
      tool('c3'),
      { kind: 'ask', id: 'q1', text: '?' },
      { kind: 'note', id: 'n1', text: 'note' },
      agent('a2'),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['user', 'turn', 'note', 'turn']);
    const turn = blocks[1];
    const parts = turn?.kind === 'turn' ? turn.parts : [];
    expect(parts.map((part) => part.kind)).toEqual(['tools', 'agent', 'tools', 'ask']);
    expect(parts[0]?.kind === 'tools' ? parts[0].calls.length : 0).toBe(2);
  });
});

describe('Buffer stand-in for the A2A client in a browser', () => {
  test('bytes go in and out of base64, and only its own bytes are a Buffer', () => {
    expect(bufferShim.isBuffer(new Uint8Array(1))).toBe(false);
    expect(bufferShim.isBuffer({ a: 1 })).toBe(false);
    const decoded = bufferShim.from('aGk=', 'base64');
    expect(bufferShim.isBuffer(decoded)).toBe(true);
    expect([...decoded]).toEqual([104, 105]);
    expect([...bufferShim.from('hi')]).toEqual([104, 105]);
    expect([...bufferShim.from([1, 2])]).toEqual([1, 2]);
    expect(bufferShim.from(Uint8Array.from([104, 105])).toString('base64')).toBe('aGk=');
    expect(bufferShim.from('aGk=', 'base64').toString()).toBe('hi');
  });

  test('carries a large image through base64 unchanged', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251);
    const encoded = bufferShim.from(bytes).toString('base64');
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(Buffer.from(bufferShim.from(encoded, 'base64')).equals(Buffer.from(bytes))).toBe(true);
  });

  test('is installed only where there is no Buffer', () => {
    const browser: { Buffer?: unknown } = {};
    installBufferShim(browser);
    expect(browser.Buffer).toBe(bufferShim);
    const node = { Buffer: 'the real one' };
    installBufferShim(node);
    expect(node.Buffer).toBe('the real one');
    installBufferShim();
    expect(Reflect.get(globalThis, 'Buffer')).toBe(Buffer);
  });
});

describe('A2UI safety (abuse case 5)', () => {
  const known = new Set(['Text', 'Column']);
  const surface = (components: unknown): unknown[] => [
    { version: '1.0', createSurface: { surfaceId: 's', catalogId: 'c', components } },
  ];

  test('only absolute https links may be opened', () => {
    expect(isSafeLink('https://example.com/a')).toBe(true);
    for (const url of ['http://example.com', 'javascript:alert(1)', '/relative', 'nonsense', 7]) {
      expect(isSafeLink(url)).toBe(false);
    }
  });

  test('an image may come from https or an inline data:image, and nowhere else', () => {
    expect(isSafeImage('https://example.com/a.png')).toBe(true);
    expect(isSafeImage(' DATA:image/png;base64,AAAA')).toBe(true);
    for (const url of [
      'data:text/html,<script>',
      'http://example.com/a.png',
      'file:///etc',
      null,
    ]) {
      expect(isSafeImage(url)).toBe(false);
    }
  });

  test('a batch whose components are all in the catalog may be drawn', () => {
    expect(inspectBatch(surface([{ id: 'root', component: 'Text', text: 'x' }]), known)).toBe(null);
    expect(
      inspectBatch([{ version: '1.0', updateDataModel: { surfaceId: 's', value: 1 } }], known),
    ).toBe(null);
    const update = { surfaceId: 's', components: [{ id: 'a', component: 'Column' }] };
    expect(inspectBatch([{ version: '1.0', updateComponents: update }], known)).toBe(null);
  });

  test('a component the catalog does not have is named', () => {
    expect(inspectBatch(surface([{ id: 'root', component: 'ScriptTag' }]), known)).toEqual({
      kind: 'unknown-component',
      component: 'ScriptTag',
    });
  });

  test('anything not shaped like A2UI 1.0 messages is malformed', () => {
    const malformed = [
      'not an array',
      [null],
      [{ version: '0.8', createSurface: {} }],
      [{ version: '1.0', createSurface: 'x' }],
      surface('not a list'),
      surface([{ id: 'root' }]),
      surface(['root']),
    ];
    for (const batch of malformed) {
      expect(inspectBatch(batch, known)).toEqual({ kind: 'malformed' });
    }
  });
});
