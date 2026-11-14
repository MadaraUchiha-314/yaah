import { describe, expect, test } from 'bun:test';

import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  test('no arguments opens the chat; --config names the file, in either spelling', () => {
    expect(parseArgs([])).toEqual({ command: 'chat', config: undefined });
    expect(parseArgs(['--config', 'a.toml'])).toEqual({ command: 'chat', config: 'a.toml' });
    expect(parseArgs(['serve', '--config=b.toml'])).toEqual({ command: 'serve', config: 'b.toml' });
  });

  test('tui needs a URL and drops its trailing slash', () => {
    expect(parseArgs(['tui', '--url', 'http://127.0.0.1:7420/'])).toEqual({
      command: 'tui',
      url: 'http://127.0.0.1:7420',
    });
    expect(parseArgs(['tui'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.url',
      subject: '',
    });
    expect(parseArgs(['tui', '--url', 'nope'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.url',
      subject: 'nope',
    });
  });

  test('help and version win over everything else', () => {
    expect(parseArgs(['serve', '-h'])).toEqual({ command: 'help' });
    expect(parseArgs(['--bogus', '--help'])).toEqual({ command: 'help' });
    expect(parseArgs(['--version'])).toEqual({ command: 'version' });
    expect(parseArgs(['-v'])).toEqual({ command: 'version' });
  });

  test('what is not understood is named', () => {
    expect(parseArgs(['--bogus'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.unknown',
      subject: '--bogus',
    });
    expect(parseArgs(['deploy'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.unknown',
      subject: 'deploy',
    });
    expect(parseArgs(['serve', 'extra'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.unknown',
      subject: 'extra',
    });
    expect(parseArgs(['--config'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.value',
      subject: '--config',
    });
    expect(parseArgs(['serve', '--url', 'http://x'])).toEqual({
      command: 'invalid',
      problem: 'cli.error.unknown',
      subject: '--url',
    });
  });
});
