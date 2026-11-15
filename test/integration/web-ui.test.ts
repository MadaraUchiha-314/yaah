import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { AGENT_CARD_PATH } from '@a2a-js/sdk';

import { BASIC_CATALOG_ID, webRenderer } from '../../src/surface/renderer/web/index.ts';
import * as webUi from '../../src/surface/renderer/web/server.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';

let running: TestHarness | undefined = undefined;
let directory: string | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

/** A stand-in for `dist/web`: a page and one asset, in `under` when given. */
function builtApp(under?: string): string {
  const dir = under ?? mkdtempSync(join(tmpdir(), 'yaah-web-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>yaah</title><div id="root"></div>');
  writeFileSync(join(dir, 'app.js'), 'export {};');
  return dir;
}

const html = { headers: { Accept: 'text/html' } };

describe('web UI plugin', () => {
  /**
   * Feature: Web renderer
   * Scenario: The harness serves the web chat from its own origin
   *   Given a harness with the web UI plugin and a built application
   *   When a browser asks for the page, an asset, and a path the application routes itself
   *   Then it gets the page, the asset, and the page again
   *   And the agent card and the A2A API still answer as before
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('The harness serves the web chat from its own origin', async () => {
    directory = builtApp();
    const config = { directory };
    running = await startHarness({
      setup: async (ctx) => {
        await ctx.use(webUi, config);
      },
    });
    const { url } = running;
    const page = await fetch(`${url}/`, html);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    const asset = await fetch(`${url}/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const deep = await fetch(`${url}/tasks/42`, html);
    expect(await deep.text()).toContain('<div id="root">');

    const card = await fetch(`${url}/${AGENT_CARD_PATH}`, html);
    expect(card.headers.get('content-type')).toContain('json');
    const api = await fetch(`${url}/a2a/rest/tasks/none`, html);
    expect(await api.text()).not.toContain('<div id="root">');
    const rpc = await fetch(`${url}/a2a`, html);
    expect(await rpc.text()).not.toContain('<div id="root">');
    // A request that does not ask for a page is not answered with one.
    const missing = await fetch(`${url}/missing.json`, { headers: { Accept: 'application/json' } });
    expect(missing.status).toBe(404);
    const posted = await fetch(`${url}/tasks/42`, { method: 'POST', ...html });
    expect(posted.status).toBe(404);
  });

  /**
   * Feature: Web renderer
   * Scenario: The page is served from a hidden or relative directory
   *   Given a built application in a directory under a dot-directory, named relatively
   *   When a browser asks for a path the application routes itself, and for an asset
   *   Then it gets the page and the asset
   *   And a file outside the directory is not served
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('The page is served from a hidden or relative directory', async () => {
    directory = mkdtempSync(join(tmpdir(), 'yaah-web-'));
    writeFileSync(join(directory, 'secret.txt'), 'secret');
    builtApp(join(directory, '.bun', 'web'));
    const app = join(directory, '.bun', 'web');
    for (const named of [app, relative(process.cwd(), app)]) {
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      running = await startHarness({
        setup: async (ctx) => {
          await ctx.use(webUi, { directory: named });
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      const deep = await fetch(`${running.url}/deep/link`, html);
      expect(deep.status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await deep.text()).toContain('<div id="root">');
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await fetch(`${running.url}/app.js`)).status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const outside = await fetch(`${running.url}/..%2F..%2Fsecret.txt`, html);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await outside.text()).not.toContain('secret');
      // oxlint-disable-next-line no-await-in-loop -- as above
      await running.stop();
      running = undefined;
    }
  });

  /**
   * Feature: Web renderer
   * Scenario: Without a built application nothing is served
   *   Given a harness whose web application was never built
   *   When the web UI plugin starts
   *   Then it registers no route and says the application is missing
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('Without a built application nothing is served', async () => {
    const missing: (readonly string[])[] = [];
    running = await startHarness({
      setup: async (ctx) => {
        ctx.on('web-ui/missing', (searched) => {
          missing.push(searched);
        });
        await ctx.use(webUi, { directory: '/nonexistent/yaah-web' });
      },
    });
    expect(missing).toEqual([['/nonexistent/yaah-web']]);
    const page = await fetch(`${running.url}/`, html);
    expect(page.status).toBe(404);
  });

  /**
   * Feature: Web renderer
   * Scenario: A disposed web UI plugin stops answering
   *   Given a harness serving the web chat
   *   When the plugin is disposed
   *   Then the page is no longer served and the API still is
   * Requirement: docs/specs/issue-3/requirements.md R1.5
   */
  test('A disposed web UI plugin stops answering', async () => {
    directory = builtApp();
    const config = { directory };
    const forks: { dispose: () => unknown }[] = [];
    running = await startHarness({
      setup: async (ctx) => {
        forks.push(await ctx.use(webUi, config));
      },
    });
    expect((await fetch(`${running.url}/`, html)).status).toBe(200);
    await forks[0]?.dispose();
    expect((await fetch(`${running.url}/`, html)).status).toBe(404);
    expect((await fetch(`${running.url}/app.js`)).status).toBe(404);
    expect((await fetch(`${running.url}/${AGENT_CARD_PATH}`)).status).toBe(200);
  });

  /**
   * Feature: Surfaces and renderers
   * Scenario: The web renderer is an entity that offers the basic catalog
   *   Given the web renderer entity
   *   Then it is a renderer called "web" that draws the A2UI basic catalog
   * Requirement: docs/specs/issue-3/requirements.md R19.1, R19.4
   */
  test('The web renderer is an entity that offers the basic catalog', () => {
    expect(webRenderer.ref).toEqual({ kind: 'renderer', id: 'web', version: null });
    expect(webRenderer.a2uiCatalogs).toEqual([BASIC_CATALOG_ID]);
    expect(webRenderer.description.length).toBeGreaterThan(0);
  });

  /**
   * Feature: Web renderer
   * Scenario: The default location is the built application of the package
   *   Given no directory option
   *   When the plugin starts in a checkout where `bun run build:web` has or has not run
   *   Then it serves the page when the build exists, and reports it missing otherwise
   * Requirement: docs/specs/issue-3/requirements.md R20.1
   */
  test('The default location is the built application of the package', async () => {
    const missing: (readonly string[])[] = [];
    running = await startHarness({
      setup: async (ctx) => {
        ctx.on('web-ui/missing', (searched) => {
          missing.push(searched);
        });
        await ctx.use(webUi, {});
      },
    });
    const page = await fetch(`${running.url}/`, html);
    expect(page.status).toBe(missing.length === 0 ? 200 : 404);
    expect(missing.flat().every((path) => path.endsWith('web'))).toBe(true);
  });
});
