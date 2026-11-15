/**
 * A JSON value. Used wherever data crosses a process, protocol or persistence boundary,
 * so that nothing in yaah is typed as "anything".
 */
export type Json = JsonPrimitive | JsonArray | JsonObject;

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON array. */
export type JsonArray = readonly Json[];

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** Narrows a JSON value to an object (not an array, not null). */
export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
