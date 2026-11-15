import { describe, expect, test } from 'bun:test';

import { defineCommand, parseCommand } from './types.ts';

describe('parseCommand', () => {
  test('splits the name from its arguments', () => {
    expect(parseCommand('/model gpt-6.1-sol')).toEqual({ name: 'model', args: 'gpt-6.1-sol' });
    expect(parseCommand('  /effort   high  ')).toEqual({ name: 'effort', args: 'high' });
    expect(parseCommand('/exit')).toEqual({ name: 'exit', args: '' });
    expect(parseCommand('/note line one\nline two')).toEqual({
      name: 'note',
      args: 'line one\nline two',
    });
  });

  test('ordinary text, paths and a lone slash are not commands', () => {
    for (const text of ['hello', 'see /model', '/', '/ model', '/1abc', 'a/b', '//x']) {
      expect(parseCommand(text)).toBeNull();
    }
  });
});

describe('defineCommand', () => {
  test('builds a harness-scoped, unversioned, local entity by default', () => {
    const command = defineCommand({
      name: 'hello',
      description: 'Say hello',
      run: () => Promise.resolve({ text: 'hi' }),
    });
    expect(command.ref).toEqual({ kind: 'command', id: 'hello', version: null });
    expect(command.scope).toBe('harness');
    expect(command.locality).toEqual({ type: 'local' });
  });
});
