import { describe, expect, test } from 'bun:test';

import { Strings, t } from './strings.ts';

describe('Strings', () => {
  const tables = {
    en: { 'greeting.hello': 'Hello, {name}!', 'only.en': 'English only' },
    fr: { 'greeting.hello': 'Bonjour, {name} !' },
  };

  test('uses the active locale when the key is present', () => {
    const strings = new Strings(tables, 'fr');
    expect(strings.t('greeting.hello', { name: 'Ada' })).toBe('Bonjour, Ada !');
  });

  test('falls back to the default locale when the key is missing', () => {
    const strings = new Strings(tables, 'fr');
    expect(strings.t('only.en')).toBe('English only');
  });

  test('falls back to the default locale when the locale is unknown', () => {
    const strings = new Strings(tables, 'de');
    expect(strings.t('greeting.hello', { name: 'Ada' })).toBe('Hello, Ada!');
  });

  test('returns the key itself when no locale has it', () => {
    const strings = new Strings(tables, 'fr');
    expect(strings.t('nope.missing')).toBe('nope.missing');
  });

  test('leaves an unknown placeholder untouched', () => {
    const strings = new Strings(tables, 'en');
    expect(strings.t('greeting.hello')).toBe('Hello, {name}!');
  });

  test('formats numbers passed as parameters', () => {
    const strings = new Strings({ en: { count: '{n} items' } }, 'en');
    expect(strings.t('count', { n: 3 })).toBe('3 items');
  });

  test('the default instance reads the shipped English table', () => {
    expect(t('error.entity.not-found', { kind: 'tool', id: 'x', version: 'null' })).toContain(
      'tool',
    );
  });
});
