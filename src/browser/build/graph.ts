/**
 * The second check of a browser build, behind a plugin's own `runtime` declaration: does
 * the code a plugin loads reach a runtime builtin (`node:fs`, `bun:sqlite`, …)? A module
 * that does cannot even be loaded in a tab, whatever it declares.
 */

/** Why a module cannot be loaded in a browser: the imports from it to a builtin. */
export interface BuiltinPath {
  /** The builtin reached, as imported. */
  readonly builtin: string;
  /** The modules from the start to the one that imports the builtin, in order. */
  readonly chain: readonly string[];
}

/** The static imports of the modules of a bundle. */
export interface ImportGraph {
  /** The modules `id` imports statically — the ones loaded whenever `id` is. */
  importsOf(id: string): readonly string[];
  /** Whether `id` is a runtime builtin. */
  isBuiltin(id: string): boolean;
}

/** Whether `specifier` names a builtin by scheme, as `node:fs` and `bun:sqlite` do. */
export function isSchemeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || specifier.startsWith('bun:');
}

/**
 * Finds the shortest chain of static imports from `start` to a builtin, or null when
 * there is none. Imports made with `import()` are not edges of the graph: they are how a
 * module keeps a Node-only branch out of the browser.
 */
export function findBuiltinPath(graph: ImportGraph, start: string): BuiltinPath | null {
  const cameFrom = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const imported of graph.importsOf(next)) {
      if (graph.isBuiltin(imported)) {
        const chain: string[] = [];
        for (let at: string | null = next; at !== null; at = cameFrom.get(at) ?? null) {
          chain.unshift(at);
        }
        return { builtin: imported, chain };
      }
      if (!cameFrom.has(imported)) {
        cameFrom.set(imported, next);
        queue.push(imported);
      }
    }
  }
  return null;
}
