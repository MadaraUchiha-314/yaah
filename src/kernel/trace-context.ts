/**
 * Where an outgoing call learns which trace it belongs to. The tracing plugin installs
 * the source; a client that calls out (another agent, an MCP server) reads it and sends
 * the value as W3C `traceparent`. With no tracing plugin there is nothing to send.
 *
 * The source is process-wide, but what it returns is scoped to the running async call,
 * so two harnesses in one process do not see each other's traces.
 */

/** Returns the `traceparent` of the work running right now, if any. */
export type TraceparentSource = () => string | undefined;

declare global {
  /**
   * The installed sources. Kept on `globalThis`: a plugin loaded from a second copy of
   * this module (a bundle beside its sources) still shares the list.
   */
  // oxlint-disable-next-line no-var, vars-on-top -- how a global is declared to TypeScript
  var yaahTraceparentSources: TraceparentSource[] | undefined;
}

function shared(): TraceparentSource[] {
  globalThis.yaahTraceparentSources ??= [];
  return globalThis.yaahTraceparentSources;
}

/** Installs a source. Returns a function that removes it. */
export function addTraceparentSource(source: TraceparentSource): () => void {
  const sources = shared();
  sources.push(source);
  return (): void => {
    const at = sources.indexOf(source);
    if (at !== -1) {
      sources.splice(at, 1);
    }
  };
}

/** The W3C `traceparent` value for a call made right now, or undefined outside a trace. */
export function currentTraceparent(): string | undefined {
  for (const source of shared()) {
    const value = source();
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
