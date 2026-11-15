import { describe, expect, test } from 'bun:test';

import * as yaah from './index.ts';

describe('package entry point', () => {
  test('exports what an embedding application needs to build a harness', () => {
    expect(typeof yaah.createHarness).toBe('function');
    expect(typeof yaah.loadConfig).toBe('function');
    expect(typeof yaah.registerEntity).toBe('function');
    expect(typeof yaah.definePrompt).toBe('function');
  });
});
