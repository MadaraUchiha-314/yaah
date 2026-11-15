import { configJsonSchema } from './config-schema.ts';
import type { Json } from './json.ts';

/**
 * The machine-readable contracts yaah publishes under `specs/`, by repo-relative path.
 *
 * Each is generated from source. The checked-in copy is the contract: a contract test
 * regenerates every entry and fails when it differs, so an interface cannot change
 * without the change showing up in review as a diff of `specs/`.
 */
export function generatedSpecs(): Readonly<Record<string, Json>> {
  return { 'specs/config/config.schema.json': configJsonSchema() };
}

/** The exact text written to, and expected in, a spec file. */
export function serializeSpec(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
