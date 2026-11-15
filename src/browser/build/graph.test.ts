import { describe, expect, test } from 'bun:test';

import type { ImportGraph } from './graph.ts';
import { findBuiltinPath, isSchemeBuiltin } from './graph.ts';

function graphOf(edges: Readonly<Record<string, readonly string[]>>): ImportGraph {
  return { importsOf: (id: string) => edges[id] ?? [], isBuiltin: isSchemeBuiltin };
}

describe('findBuiltinPath', () => {
  test('finds the shortest chain of static imports to a builtin', () => {
    const graph = graphOf({
      plugin: ['helper', 'long'],
      long: ['longer'],
      longer: ['node:fs'],
      helper: ['store'],
      store: ['bun:sqlite', 'plugin'],
    });
    expect(findBuiltinPath(graph, 'plugin')).toEqual({
      builtin: 'bun:sqlite',
      chain: ['plugin', 'helper', 'store'],
    });
  });

  test('names the module itself when it imports the builtin directly', () => {
    expect(findBuiltinPath(graphOf({ plugin: ['node:http'] }), 'plugin')).toEqual({
      builtin: 'node:http',
      chain: ['plugin'],
    });
  });

  test('returns null when no builtin is reached, cycles included', () => {
    const graph = graphOf({ plugin: ['a', 'b'], a: ['b'], b: ['a', 'plugin'] });
    expect(findBuiltinPath(graph, 'plugin')).toBeNull();
    expect(findBuiltinPath(graphOf({}), 'alone')).toBeNull();
  });
});

describe('isSchemeBuiltin', () => {
  test('knows the builtins of both runtimes by their scheme', () => {
    expect(
      ['node:fs', 'bun:sqlite', 'fs', './node:x', 'react'].map((id) => isSchemeBuiltin(id)),
    ).toEqual([true, true, false, false, false]);
  });
});
