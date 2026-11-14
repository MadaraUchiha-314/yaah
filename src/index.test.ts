import { describe, expect, test } from 'bun:test';

import { NAME, greet } from './index.ts';

describe('index', () => {
  test('exports the package name', () => {
    expect(NAME).toBe('yaah');
  });

  test('greet includes the name', () => {
    expect(greet('world')).toBe('Hello from yaah, world!');
  });
});
