/**
 * The web UI plugin: serves the built chat application (`bun run build:web`) from the
 * harness's own HTTP listener, so the page and the A2A API share one origin.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Context } from 'cordis';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import express from 'express';

import { assetPath } from '../../../kernel/assets.ts';

declare module 'cordis' {
  interface Events {
    /** The built web application was not found; nothing is served. */
    'web-ui/missing'(searched: readonly string[]): void;
  }
}

/** Options of the web UI plugin. */
export interface WebUiConfig {
  /** The directory holding the built application. Defaults to the package's `dist/web`. */
  readonly directory?: string;
}

export const name = 'web-ui';
/** The runtimes this plugin runs on: it serves files over the HTTP listener, so a browser build refuses it. */
export const runtime: readonly string[] = ['node'];
export const inject: readonly string[] = ['http'];

/** Paths that belong to the A2A API and the agent card: never answered with the page. */
const RESERVED: readonly string[] = ['/a2a', '/.well-known/'];

/**
 * Where the built application may be: beside the code in a built package, or in the
 * repository's `dist/` when running from a source checkout.
 */
function candidates(): string[] {
  return [assetPath('web'), assetPath('..', 'dist', 'web')];
}

function isReserved(path: string): boolean {
  return RESERVED.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}

/** Sends `index.html` for any other GET that asks for a page: the application routes itself. */
function pageFallback(directory: string, active: () => boolean): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    // A browser navigating names `text/html`; a script fetching data (`*/*`) does not.
    const wantsPage =
      request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
    if (!active() || !wantsPage || isReserved(request.path)) {
      next();
      return;
    }
    // Sent relative to its directory as root: a dot segment above it (`~/.bun/…`) is not a
    // hidden file, and a relative directory is resolved first.
    response.sendFile('index.html', { root: resolve(directory) });
  };
}

/** Starts serving the web application, when it has been built. */
export function apply(ctx: Context, config: WebUiConfig = {}): void {
  const searched = config.directory === undefined ? candidates() : [config.directory];
  const directory = searched.find((candidate) => existsSync(join(candidate, 'index.html')));
  if (directory === undefined) {
    ctx.emit('web-ui/missing', searched);
    return;
  }
  // Express has no way to remove a route: the handlers stay and step aside once disposed.
  let serving = true;
  const active = (): boolean => serving;
  const assets = express.static(directory, { index: 'index.html', fallthrough: true });
  ctx.http.app.use((request: Request, response: Response, next: NextFunction): void => {
    if (!active() || isReserved(request.path)) {
      next();
      return;
    }
    assets(request, response, next);
  });
  ctx.http.app.use(pageFallback(directory, active));
  ctx.effect(() => (): void => {
    serving = false;
  });
}
