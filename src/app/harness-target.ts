/**
 * The `harnessTarget` service: how an A2A client in this process reaches this harness.
 * Declared apart from the HTTP plugin so that a build without a listener, and a surface
 * in a browser, can name it without loading Express.
 */
import type { Client } from '@a2a-js/sdk/client';
import type { A2ARequestHandler } from '@a2a-js/sdk/server';
// The augmentation below merges into cordis' `Context` only where cordis is imported.
// oxlint-disable-next-line import/no-empty-named-blocks, unicorn/require-module-specifiers -- imported for the module augmentation alone
import type {} from 'cordis';

/**
 * How an A2A client reaches this harness: over HTTP at a URL, or — in a build with no
 * listener — through an in-memory transport onto the same request handler.
 */
export type HarnessTarget =
  | { readonly type: 'http'; readonly url: string }
  | {
      readonly type: 'in-memory';
      /** The request handler of this harness, as it stands when read. */
      readonly handler: A2ARequestHandler;
      /** Opens an SDK client on {@link handler} through the in-memory transport. */
      connect(): Promise<Client>;
    };

declare module 'cordis' {
  interface Context {
    /** How surfaces and the `self` sub-agent reach this harness. */
    harnessTarget: HarnessTarget;
  }
}
