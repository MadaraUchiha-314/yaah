/**
 * The A2UI state of one answer: the official message processor, fed the answer's batches
 * in order as they arrive, with every batch inspected first.
 */
import type { ReactCatalogComponent } from '@a2ui/react';
import type { ActionPayload, SurfaceModel } from '@a2ui/web_core/v1_0';
import { MessageProcessor } from '@a2ui/web_core/v1_0';

import { t } from '../../../../kernel/strings.ts';
import { KNOWN_COMPONENTS, webCatalog } from './catalog.tsx';
import { inspectBatch } from './safety.ts';

/** A user's action on a surface, as the A2UI 1.0 message a renderer sends to the agent. */
export interface ActionMessage {
  readonly version: '1.0';
  readonly action: ActionPayload;
}

/** What to draw for an answer's A2UI: its surfaces, and a line for each batch refused. */
export interface StageSnapshot {
  readonly surfaces: readonly SurfaceModel<ReactCatalogComponent>[];
  /** The `component` of each fallback line, in order. */
  readonly refused: readonly string[];
}

/** Holds the surfaces one answer has created. */
export class A2uiStage {
  readonly #onAction: (message: ActionMessage) => void;
  #processor: MessageProcessor<ReactCatalogComponent> | null = null;
  #fed: readonly unknown[] = [];
  #refused: string[] = [];

  constructor(onAction: (message: ActionMessage) => void) {
    this.#onAction = onAction;
  }

  /**
   * Brings the stage up to date with `batches` and returns what to draw. Feeding the same
   * batches again changes nothing; batches that no longer extend what was fed start over.
   */
  feed(batches: readonly unknown[]): StageSnapshot {
    const continues = this.#fed.every((batch, index) => batches[index] === batch);
    if (!continues || this.#processor === null) {
      this.dispose();
      this.#processor = new MessageProcessor<ReactCatalogComponent>([webCatalog], (action) => {
        this.#onAction({ version: '1.0', action });
      });
    }
    for (const batch of batches.slice(this.#fed.length)) {
      this.#process(this.#processor, batch);
    }
    this.#fed = batches;
    return { surfaces: [...this.#processor.getSurfaces().values()], refused: [...this.#refused] };
  }

  /** Tears the surfaces down. A later {@link feed} starts from nothing. */
  dispose(): void {
    this.#processor?.dispose();
    this.#processor = null;
    this.#fed = [];
    this.#refused = [];
  }

  #process(processor: MessageProcessor<ReactCatalogComponent>, batch: unknown): void {
    const problem = inspectBatch(batch, KNOWN_COMPONENTS);
    if (problem !== null) {
      this.#refused.push(
        problem.kind === 'unknown-component' ? problem.component : t('web.a2ui.malformed'),
      );
      return;
    }
    try {
      processor.processMessages({ messages: Array.isArray(batch) ? batch : [] });
    } catch {
      // The processor found the batch invalid: nothing of it is drawn.
      this.#refused.push(t('web.a2ui.malformed'));
    }
  }
}
