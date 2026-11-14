import type { Json } from './json.ts';
import { isJsonObject } from './json.ts';

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** A secret shorter than this is not matched as a substring: it would hit ordinary text. */
const MIN_SECRET_LENGTH = 8;

const SENSITIVE_KEY = /key|token|secret|authorization|password|cookie/iu;

/**
 * Removes credentials from anything about to leave the process: log records, span
 * attributes, errors returned to callers, and content written to a conversation.
 *
 * Two rules. Every known secret value is replaced wherever it occurs **as a substring**
 * of any string. And any value stored under a key whose name looks sensitive is blanked
 * whatever it holds.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  constructor(secrets: readonly string[] = []) {
    for (const secret of secrets) {
      this.add(secret);
    }
  }

  /** Registers a secret value. Values shorter than 8 characters are ignored. */
  add(secret: string): void {
    if (secret.length >= MIN_SECRET_LENGTH) {
      this.#secrets.add(secret);
    }
  }

  /** Whether `text` contains any registered secret. */
  contains(text: string): boolean {
    for (const secret of this.#secrets) {
      if (text.includes(secret)) {
        return true;
      }
    }
    return false;
  }

  /** Replaces every occurrence of every registered secret in `text`. */
  redactString(text: string): string {
    let result = text;
    for (const secret of this.#secrets) {
      result = result.replaceAll(secret, REDACTED);
    }
    return result;
  }

  /** Returns a copy of `value` with secrets replaced and sensitive keys blanked. */
  redact(value: Json): Json {
    if (typeof value === 'string') {
      return this.redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item: Json) => this.redact(item));
    }
    if (value !== null && typeof value === 'object' && isJsonObject(value)) {
      const copy: Record<string, Json> = {};
      for (const [key, item] of Object.entries(value)) {
        copy[key] = SENSITIVE_KEY.test(key) ? REDACTED : this.redact(item);
      }
      return copy;
    }
    return value;
  }
}
