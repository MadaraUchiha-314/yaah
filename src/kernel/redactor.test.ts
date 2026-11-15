import { describe, expect, test } from 'bun:test';

import { REDACTED, Redactor } from './redactor.ts';

describe('Redactor', () => {
  const secret = 'sk-test-1234567890abcdef';
  const redactor = new Redactor([secret]);

  test('replaces a credential that appears as a substring', () => {
    expect(redactor.redactString(`request failed using ${secret} today`)).toBe(
      `request failed using ${REDACTED} today`,
    );
  });

  test('replaces every occurrence', () => {
    expect(redactor.redactString(`${secret}/${secret}`)).toBe(`${REDACTED}/${REDACTED}`);
  });

  test('blanks values under sensitive key names', () => {
    expect(
      redactor.redact({ authorization: 'Bearer abc', apiKey: 'k', nested: { password: 'p' } }),
    ).toEqual({ authorization: REDACTED, apiKey: REDACTED, nested: { password: REDACTED } });
  });

  test('walks arrays and leaves non-strings alone', () => {
    expect(redactor.redact([1, true, null, `x ${secret}`])).toEqual([
      1,
      true,
      null,
      `x ${REDACTED}`,
    ]);
  });

  test('redacts credentials inside nested string values under ordinary keys', () => {
    expect(redactor.redact({ message: `bad ${secret}` })).toEqual({ message: `bad ${REDACTED}` });
  });

  test('ignores secrets too short to match safely', () => {
    const short = new Redactor(['abc', '']);
    expect(short.redactString('abc abc')).toBe('abc abc');
  });

  test('learns a secret added later', () => {
    const later = new Redactor([]);
    later.add('another-secret-value');
    expect(later.redactString('x another-secret-value')).toBe(`x ${REDACTED}`);
  });

  test('contains reports whether any secret is present', () => {
    expect(redactor.contains(`a ${secret}`)).toBe(true);
    expect(redactor.contains('clean')).toBe(false);
  });
});
