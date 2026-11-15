/**
 * Surfaces and renderers as entities. A surface is how a person reaches a harness — a
 * terminal, a browser tab; a renderer is how what the harness produces is shown there.
 */
import type { Entity } from '../kernel/entity.ts';

declare module '../kernel/entity.ts' {
  interface EntityMap {
    surface: Surface;
    renderer: Renderer;
  }
}

/** How a surface takes input and gives output. */
export type Modality = 'text' | 'image' | 'audio';

/** A way of showing messages and artifacts. */
export interface Renderer extends Entity<'renderer'> {
  /** Ids of the A2UI catalogs this renderer can draw; empty when it draws text only. */
  readonly a2uiCatalogs: readonly string[];
}

/** A way for a person to reach a harness. */
export interface Surface extends Entity<'surface'> {
  readonly modalities: readonly Modality[];
  /** The renderer this surface draws with. */
  readonly renderer: Renderer;
  /**
   * Opens the surface against the harness at `url` and resolves when the person leaves.
   * A surface reaches the harness only through the A2A SDK client.
   */
  open(url: string): Promise<void>;
}
