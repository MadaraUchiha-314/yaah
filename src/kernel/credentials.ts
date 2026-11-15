import type { Context } from 'cordis';

/**
 * Secrets by the name a configuration gives them (`api_key_env`), handed to a harness
 * that has no process environment to read them from — the browser build.
 */
export type Credentials = Readonly<Record<string, string>>;

declare module 'cordis' {
  interface Context {
    /** Named secrets given to this harness when it was created. Absent on Node. */
    credentials: Credentials;
  }
}

/**
 * Reads the secret a configuration names: from the credentials this harness was given,
 * else from the process environment where there is one.
 */
export function readCredential(ctx: Context, variable: string): string | undefined {
  const given = ctx.get('credentials')?.[variable];
  if (given !== undefined) {
    return given;
  }
  return typeof process === 'undefined' ? undefined : process.env[variable];
}
