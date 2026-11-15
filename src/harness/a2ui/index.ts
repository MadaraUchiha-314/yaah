/**
 * The A2UI plugin: lets the agent answer with user interface, not only text.
 *
 * When a client says, on a message, which A2UI catalogs it can render, the model is
 * taught the A2UI output format for that turn, and what it writes between `<a2ui>` tags
 * is compiled and validated against the catalog by the official A2UI agent SDK. Only
 * validated UI messages leave the harness; a block that fails validation is dropped.
 */
import { fileURLToPath } from 'node:url';

import type { StreamPart } from '@a2ui/agent';
import { A2uiGenerator, CatalogConfig } from '@a2ui/agent';
import type { Context } from 'cordis';
import { z } from 'zod';

import type { ReplyPiece, ReplyStream, TurnExtension } from '../core/steps.ts';
import type { TaskSnapshot } from '../core/task-port.ts';
import type { Json } from '../../kernel/json.ts';

/** The official A2A extension through which A2UI travels. */
export const A2UI_EXTENSION = 'https://a2ui.org/a2a-extension/a2ui/v1.0';
/** The media type of a part that carries A2UI messages. */
export const A2UI_MEDIA_TYPE = 'application/a2ui+json';
/** The message metadata key under which a client states what it can render. */
export const A2UI_CAPABILITIES_KEY = 'a2uiRendererCapabilities';
/** The id of the basic catalog of A2UI 1.0. */
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

declare module 'cordis' {
  interface Events {
    /** The model wrote an A2UI block that did not pass validation; it was dropped. */
    'a2ui/rejected'(taskId: string, reason: string): void;
  }
}

export const name = 'a2ui';
/** The runtimes this plugin runs on: the A2UI agent SDK reads its catalog from the file system, so a browser build refuses it. */
export const runtime: readonly string[] = ['node'];
export const inject: readonly string[] = ['a2a', 'taskRuntime'];

/**
 * What a client states it can render, per A2UI version. Catalogs sent inline are not
 * accepted (the card says so), so only catalog ids are read.
 */
const capabilities = z.record(z.string(), z.object({ supportedCatalogIds: z.array(z.string()) }));

/** Where the basic catalog's schema is, inside the installed A2UI core package. */
function basicCatalogPath(): string {
  const entry = fileURLToPath(import.meta.resolve('@a2ui/web_core'));
  const marker = '/@a2ui/web_core/';
  const root = entry.slice(0, entry.lastIndexOf(marker) + marker.length);
  return `${root}src/v1_0/schemas/catalogs/basic/catalog.json`;
}

/** JSON as produced by the SDK: plain data by its own contract. */
function toJson(value: unknown): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated UI messages are plain JSON
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Starts the A2UI plugin. */
export function apply(ctx: Context): void {
  const generator = new A2uiGenerator([CatalogConfig.fromPath(basicCatalogPath())]);
  const extensionFor = (task: TaskSnapshot): TurnExtension | null => {
    const offered = capabilities.safeParse(task.turnMetadata[A2UI_CAPABILITIES_KEY]);
    if (!offered.success) {
      // The client did not offer A2UI for this turn: answer in text.
      return null;
    }
    try {
      const processor = generator.createProcessor(offered.data);
      const pieces = (parts: Iterable<StreamPart>): ReplyPiece[] => {
        const out: ReplyPiece[] = [];
        for (const part of parts) {
          if (part.type === 'text') {
            out.push({ type: 'text', text: part.text });
          } else if (part.type === 'a2ui') {
            out.push({ type: 'data', mediaType: A2UI_MEDIA_TYPE, data: toJson(part.a2ui) });
          } else {
            ctx.emit('a2ui/rejected', task.taskId, part.error.message);
          }
        }
        return out;
      };
      return {
        promptSection: processor.promptSnippet,
        openReply: (): ReplyStream => {
          const stream = processor.openStream({ afterRejectedBlock: 'continue' });
          return {
            feed: (chunk: string): ReplyPiece[] => pieces(stream.feed(chunk)),
            close: (): ReplyPiece[] => pieces(stream.close()),
          };
        },
      };
    } catch (error) {
      // What the client offered matches no catalog this harness has.
      ctx.emit(
        'a2ui/rejected',
        task.taskId,
        error instanceof Error ? error.message : 'unsupported',
      );
      return null;
    }
  };
  ctx.effect(() => ctx.taskRuntime.addTurnExtension(extensionFor));
  ctx.effect(() =>
    ctx.a2a.addExtension({
      uri: A2UI_EXTENSION,
      description: 'Agent-generated user interface (A2UI 1.0, basic catalog).',
      required: false,
      params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false },
    }),
  );
}
