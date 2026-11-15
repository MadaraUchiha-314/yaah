import en from '../locales/en.json' with { type: 'json' };

/** One locale's strings: message key to template. */
export type StringTable = Readonly<Record<string, string>>;

/** Values substituted into `{name}` placeholders. */
export type StringParams = Readonly<Record<string, string | number>>;

/** The locale every lookup falls back to. */
export const DEFAULT_LOCALE = 'en';

const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * User-visible strings, looked up by key.
 *
 * Invariant: source code holds no user-visible literal — every message lives in a locale
 * table (`src/locales/<locale>.json`) and is fetched through {@link Strings.t}.
 *
 * A key missing from the active locale is read from {@link DEFAULT_LOCALE}; a key missing
 * there too is returned as-is, so a missing string is visible rather than fatal.
 */
export class Strings {
  readonly #tables: Readonly<Record<string, StringTable>>;
  readonly #locale: string;

  constructor(tables: Readonly<Record<string, StringTable>>, locale: string = DEFAULT_LOCALE) {
    this.#tables = tables;
    this.#locale = locale;
  }

  /** Returns the string for `key` with `{placeholders}` filled from `params`. */
  t(key: string, params: StringParams = {}): string {
    const template =
      this.#tables[this.#locale]?.[key] ?? this.#tables[DEFAULT_LOCALE]?.[key] ?? key;
    return template.replaceAll(PLACEHOLDER, (whole: string, name: string) => {
      const value = params[name];
      return value === undefined ? whole : String(value);
    });
  }
}

/** The tables shipped with the package. */
export const SHIPPED_TABLES: Readonly<Record<string, StringTable>> = { [DEFAULT_LOCALE]: en };

const shipped = new Strings(SHIPPED_TABLES);

/** Looks a key up in the shipped English table. Used where no locale is known yet. */
export function t(key: string, params: StringParams = {}): string {
  return shipped.t(key, params);
}
