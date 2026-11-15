/**
 * The browser composition for tests, on Bun or Node: `browser.yml` resolved and imported
 * the way the build resolves it, started with `createBrowserHarness`, with a scripted
 * model. There is no listener; a test reaches the harness through `ctx.harnessTarget`.
 */
import { fileURLToPath } from 'node:url';

import type { Context } from 'cordis';

import type { HarnessTarget } from '../../src/app/harness-target.ts';
import { loadBrowserComposition } from '../../src/browser/build/resolve.ts';
import type { BrowserComposition } from '../../src/browser/harness.ts';
import { createBrowserHarness } from '../../src/browser/harness.ts';
import type { Tool } from '../../src/harness/tools/types.ts';
import type { Harness } from '../../src/kernel/bootstrap.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import type { ScriptedTurn } from '../../src/testing/scripted-llm.ts';
import { ScriptedLlm } from '../../src/testing/scripted-llm.ts';

/** The shipped browser composition. */
export const BROWSER_YML: string = fileURLToPath(
  new URL('../../src/compositions/browser.yml', import.meta.url),
);
/** The shipped prompts. */
export const PROMPTS_DIR: string = fileURLToPath(new URL('../../src/prompts', import.meta.url));

/** Options of {@link startBrowserHarness}. */
export interface BrowserHarnessOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly tools?: readonly Tool[];
  readonly llmDelayMs?: number;
  /** Extra `config.toml` text, appended to the test defaults. */
  readonly config?: string;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly composition?: BrowserComposition;
  readonly setup?: (ctx: Context) => void | Promise<void>;
}

/** A running browser-composition harness. */
export interface TestBrowserHarness {
  readonly harness: Harness;
  readonly llm: ScriptedLlm;
  readonly target: HarnessTarget;
  stop(): Promise<void>;
}

/** Starts the browser composition with a scripted model. */
export async function startBrowserHarness(
  options: BrowserHarnessOptions = {},
): Promise<TestBrowserHarness> {
  const llm = new ScriptedLlm(
    options.turns ?? [],
    options.llmDelayMs === undefined ? {} : { delayMs: options.llmDelayMs },
  );
  const config = parseConfig(
    [
      'data_dir = ":memory:"',
      `model = { llm = ${JSON.stringify(llm.ref.id)}, effort = "medium" }`,
      options.config ?? '',
    ].join('\n'),
    'browser-test.toml',
  );
  const harness = await createBrowserHarness({
    composition: options.composition ?? (await loadBrowserComposition(BROWSER_YML, PROMPTS_DIR)),
    config,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    setup: async (ctx) => {
      registerEntity(ctx, llm);
      for (const tool of options.tools ?? []) {
        registerEntity(ctx, tool);
      }
      await options.setup?.(ctx);
    },
  });
  return {
    harness,
    llm,
    target: harness.ctx.harnessTarget,
    stop: async () => {
      await harness.dispose();
    },
  };
}
