/**
 * The entity model: one address scheme and one base shape for every pluggable thing in
 * yaah — prompts, skills, tools, models, agents, commands, channels, surfaces, renderers.
 */

/**
 * Maps an entity kind to its interface. Each module that defines a kind adds it here by
 * declaration merging, so the registry is typed without the kernel importing the module:
 *
 * ```ts
 * declare module '../../kernel/entity.ts' {
 *   interface EntityMap { tool: Tool }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-object-type, typescript/no-empty-interface -- filled by declaration merging
export interface EntityMap {}

/** The name of a registered entity kind. */
export type EntityKind = keyof EntityMap;

/** The interface of the entities of kind `K`. */
export type EntityOf<K extends EntityKind> = EntityMap[K];

/** Any registered entity, whatever its kind. */
export type AnyEntity = EntityMap[EntityKind];

/**
 * The address of one entity instance.
 *
 * Invariant: `(kind, id, version)` identifies at most one registered entity. `version` is
 * `null` for a kind, or an instance, that is not versioned — never an empty string.
 */
export interface EntityRef<K extends string = string> {
  readonly kind: K;
  readonly id: string;
  readonly version: string | null;
}

/**
 * Where an entity runs. A remote entity names the application protocol that reaches it;
 * callers never see the difference beyond this field.
 */
export type Locality =
  | { readonly type: 'local' }
  | {
      readonly type: 'remote';
      readonly protocol: 'a2a' | 'mcp' | 'https';
      readonly url: string;
    };

/** What every entity carries, whatever its kind. */
export interface Entity<K extends string = string> {
  /** This entity's address. */
  readonly ref: EntityRef<K>;
  /** One or two sentences a person, or a model, can choose it by. */
  readonly description: string;
  /** Whether it runs in this process or behind a protocol. */
  readonly locality: Locality;
}

/** The locality of an entity that runs in this process. */
export const LOCAL: Locality = { type: 'local' };

/** Renders a reference as `kind:id@version` for logs and map keys. */
export function formatRef(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}@${ref.version ?? 'null'}`;
}
