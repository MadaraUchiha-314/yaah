/**
 * The state behind the A2UI an answer carries: surfaces, components and data models,
 * held by the headless parts of the official `@a2ui/web_core` library (its message
 * processor and node resolver — no DOM), and read out as {@link A2uiNode} trees.
 */
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import { MessageProcessor } from '@a2ui/web_core/processing';
import { peekValue } from '@a2ui/web_core/reactivity';
import type { ComponentNode } from '@a2ui/web_core/resolution';
import {
  NodeResolver,
  ResolvedBinding,
  WritableBinding,
  isComponentNode,
} from '@a2ui/web_core/resolution';

import type { A2uiNode } from './a2ui-tree.ts';
import { toNode } from './a2ui-tree.ts';
import { sanitizeDeep } from './filter.ts';

/** The id of the A2UI 1.0 basic catalog — the one catalog this renderer draws. */
export const BASIC_CATALOG_ID: string = basicCatalog.id;

/** One A2UI surface, ready to draw. `root` is null until its root component arrives. */
export interface A2uiSurface {
  readonly surfaceId: string;
  readonly root: A2uiNode | null;
}

/** What a user's action on a surface sends back to the agent (A2UI 1.0 `action`). */
export interface A2uiAction {
  readonly name: string;
  readonly surfaceId: string;
  readonly sourceComponentId: string;
  readonly timestamp: string;
  readonly context: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two batches are the same: the same value, or equal as JSON. */
function sameBatch(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

interface Resolved {
  readonly resolver: NodeResolver;
  /** The live nodes of the last reading, by the id the drawn tree knows them by. */
  readonly nodes: Map<string, ComponentNode>;
}

/**
 * The A2UI surfaces of one answer.
 *
 * Invariant: no method throws on what an agent sent. A message the library rejects is
 * counted in {@link A2uiModel.rejected} and changes nothing else.
 */
export class A2uiModel {
  readonly #actions: A2uiAction[] = [];
  #processor: MessageProcessor = this.#createProcessor();
  readonly #resolved = new Map<string, Resolved>();
  /** Values the user set on controls that are not bound to the data model. */
  readonly #local = new Map<string, unknown>();
  /** The batches fed so far, in order. */
  #fed: readonly unknown[] = [];
  #rejected = 0;

  /** How many message batches were malformed and therefore not applied. */
  get rejected(): number {
    return this.#rejected;
  }

  /**
   * Feeds the batches of an answer. Batches already fed are skipped, so this can be
   * called with the growing list of a streaming answer. A list that does not extend the
   * one fed — the answer's step was retried and streamed anew — starts the surfaces over.
   */
  apply(batches: readonly unknown[]): void {
    if (!this.#fed.every((batch, index) => sameBatch(batches[index], batch))) {
      this.dispose();
      this.#processor = this.#createProcessor();
      this.#local.clear();
      this.#fed = [];
      this.#rejected = 0;
    }
    const fresh = batches.slice(this.#fed.length);
    this.#fed = [...batches];
    for (const batch of fresh) {
      try {
        if (this.#processor.processMessagesWithErrors(sanitizeDeep(batch)).length > 0) {
          this.#rejected += 1;
        }
      } catch {
        this.#rejected += 1;
      }
    }
  }

  /** The surfaces as they stand, in creation order. */
  surfaces(): A2uiSurface[] {
    const surfaces: A2uiSurface[] = [];
    for (const [surfaceId, surface] of this.#processor.getSurfaces()) {
      try {
        const resolved = this.#resolved.get(surfaceId) ?? {
          resolver: new NodeResolver(surface),
          nodes: new Map<string, ComponentNode>(),
        };
        this.#resolved.set(surfaceId, resolved);
        resolved.nodes.clear();
        const root = this.#plain(surfaceId, peekValue(resolved.resolver.rootNode), resolved.nodes);
        surfaces.push({ surfaceId, root: toNode(root) });
      } catch {
        surfaces.push({ surfaceId, root: null });
      }
    }
    return surfaces;
  }

  /** Sets the value of a control: in the data model when it is bound there, else locally. */
  set(surfaceId: string, id: string, value: unknown): void {
    const node = this.#resolved.get(surfaceId)?.nodes.get(id);
    const binding = node === undefined ? undefined : peekValue(node.props)['value'];
    try {
      if (binding instanceof WritableBinding) {
        binding.set(value);
        return;
      }
    } catch {
      // A value the data model refuses is kept beside it instead.
    }
    this.#local.set(`${surfaceId}\n${id}`, value);
  }

  /**
   * Runs the action of a button: resolves its context against the data model and
   * returns the action to send to the agent, or null when the button has none (or
   * its action only runs a local function).
   */
  async activate(surfaceId: string, id: string): Promise<A2uiAction | null> {
    const context = this.#resolved.get(surfaceId)?.nodes.get(id)?.context;
    if (context === undefined) {
      return null;
    }
    this.#actions.length = 0;
    try {
      const raw: unknown = context.componentModel.properties['action'];
      const resolved: unknown = isRecord(raw)
        ? context.dataContext.resolveAction(raw, { userActivation: true })
        : undefined;
      if (isRecord(resolved)) {
        await context.dispatchAction(resolved);
      }
    } catch {
      return null;
    }
    return this.#actions.shift() ?? null;
  }

  /** Releases the library's subscriptions. The model must not be used afterwards. */
  dispose(): void {
    for (const { resolver } of this.#resolved.values()) {
      resolver.dispose();
    }
    this.#resolved.clear();
    this.#processor.dispose();
  }

  #createProcessor(): MessageProcessor {
    return new MessageProcessor([basicCatalog], (action) => {
      this.#actions.push({
        name: action.name,
        surfaceId: action.surfaceId,
        sourceComponentId: action.sourceComponentId,
        timestamp: action.timestamp,
        context: action.context,
      });
    });
  }

  /** Reads a resolved value out as plain JSON, noting each live node on the way. */
  #plain(surfaceId: string, value: unknown, nodes: Map<string, ComponentNode>): unknown {
    if (isComponentNode(value)) {
      const id = value.instanceId;
      nodes.set(id, value);
      const props = value.isPlaceholder ? {} : peekValue(value.props);
      const plain: Record<string, unknown> = { id, type: value.type, state: value.state };
      for (const [key, entry] of Object.entries(props)) {
        plain[key] = this.#plain(surfaceId, entry, nodes);
      }
      const local = `${surfaceId}\n${id}`;
      return this.#local.has(local) ? { ...plain, value: this.#local.get(local) } : plain;
    }
    if (value instanceof ResolvedBinding) {
      const inner: unknown = value.value;
      return this.#plain(surfaceId, inner, nodes);
    }
    if (Array.isArray(value)) {
      return value.map((entry: unknown) => this.#plain(surfaceId, entry, nodes));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.#plain(surfaceId, entry, nodes)]),
      );
    }
    return typeof value === 'function' ? null : value;
  }
}
