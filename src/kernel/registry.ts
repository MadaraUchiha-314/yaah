import type { Context } from 'cordis';

import type { AnyEntity, EntityKind, EntityOf, EntityRef } from './entity.ts';
import { formatRef } from './entity.ts';
import { EntityConflictError, EntityNotFoundError } from './errors.ts';

/** Undoes one registration. Safe to call more than once. */
export type Disposer = () => void;

/** Options for {@link EntityRegistry.register}. */
export interface RegisterOptions {
  /** Replace an entity already registered under the same address. */
  readonly override?: boolean;
}

function isOfKind<K extends EntityKind>(entity: AnyEntity, kind: K): entity is EntityOf<K> {
  return entity.ref.kind === kind;
}

declare module 'cordis' {
  interface Context {
    /** The entity registry — every pluggable thing, by `(kind, id, version)`. */
    entities: EntityRegistry;
  }
}

/**
 * The registry of entity instances.
 *
 * Invariants:
 * - `(kind, id, version)` resolves to at most one entity, and `resolve` never returns an
 *   entity of another version.
 * - A registration that overrode another restores it when disposed, so removing an
 *   operator's override brings the default back.
 *
 * Provided to plugins as the cordis service `ctx.entities`. Inside a plugin, register
 * through {@link registerEntity} so that disposing the plugin removes what it added.
 */
export class EntityRegistry {
  /** Per address, the stack of registrations; the last one is the live entity. */
  readonly #stacks = new Map<string, AnyEntity[]>();

  /**
   * Registers `entity` under its own `ref`.
   *
   * @throws EntityConflictError when the address is taken and `opts.override` is not true.
   */
  register(entity: AnyEntity, opts: RegisterOptions = {}): Disposer {
    const registered = entity;
    const key = formatRef(registered.ref);
    const stack = this.#stacks.get(key) ?? [];
    if (stack.length > 0 && opts.override !== true) {
      throw new EntityConflictError(registered.ref);
    }
    stack.push(registered);
    this.#stacks.set(key, stack);
    return () => {
      const current = this.#stacks.get(key);
      const index = current?.lastIndexOf(registered) ?? -1;
      if (current === undefined || index === -1) {
        return;
      }
      current.splice(index, 1);
      if (current.length === 0) {
        this.#stacks.delete(key);
      }
    };
  }

  /** Whether an entity is registered under `ref`. */
  has(ref: EntityRef): boolean {
    return this.#stacks.has(formatRef(ref));
  }

  /**
   * Returns the entity registered under exactly `ref`.
   *
   * @throws EntityNotFoundError when nothing is registered there.
   */
  resolve<K extends EntityKind>(ref: EntityRef<K>): EntityOf<K> {
    const live = this.#stacks.get(formatRef(ref))?.at(-1);
    if (live === undefined || !isOfKind(live, ref.kind)) {
      throw new EntityNotFoundError(ref);
    }
    return live;
  }

  /** Every live entity of `kind`, ordered by id then version, so listings are stable. */
  list<K extends EntityKind>(kind: K): readonly EntityOf<K>[] {
    const found: EntityOf<K>[] = [];
    for (const stack of this.#stacks.values()) {
      const live = stack.at(-1);
      if (live !== undefined && isOfKind(live, kind)) {
        found.push(live);
      }
    }
    return found.toSorted((a: EntityOf<K>, b: EntityOf<K>) =>
      formatRef(a.ref).localeCompare(formatRef(b.ref)),
    );
  }
}

/**
 * Registers an entity for the lifetime of the calling plugin: when the plugin's context
 * is disposed, the entity is removed.
 */
export function registerEntity(ctx: Context, entity: AnyEntity, opts: RegisterOptions = {}): void {
  ctx.effect(() => ctx.entities.register(entity, opts));
}
