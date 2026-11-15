import type { Message, Part } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';
import { describe, expect, test } from 'bun:test';

import { rawPart, urlPart } from '../../../test/support/media.ts';
import { PartTooLargeError, partSizeAdmission } from './part-limit.ts';

function message(...parts: Part[]): Message {
  return {
    messageId: 'm1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

const bytes = (length: number): string => Buffer.alloc(length, 1).toString('base64');

describe('part size admission', () => {
  test('admits binary parts up to the limit, and parts that carry no bytes', async () => {
    const admit = partSizeAdmission(100);
    const fine = message(rawPart('image/png', bytes(100)), urlPart('image/png', 'https://x/y'));
    const outcomes = await Promise.allSettled([admit(fine), admit(message())]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  test('refuses a binary part over the limit, stating the limit', async () => {
    const admit = partSizeAdmission(100);
    const refused = await admit(message(rawPart('audio/wav', bytes(101)))).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PartTooLargeError);
    expect(refused instanceof PartTooLargeError && refused.limit).toBe(100);
    expect(refused instanceof PartTooLargeError && refused.code).toBe('limit.part-size');
    expect(refused instanceof Error ? refused.message : '').toContain('100');
  });

  test('measures a text part in UTF-8 bytes, not characters (critic 1, #4)', async () => {
    const admit = partSizeAdmission(100);
    const text = (value: string): Part => ({
      content: { $case: 'text', value },
      mediaType: 'text/plain',
      filename: '',
      metadata: undefined,
    });
    // 34 characters, 102 bytes: over the limit though short.
    const refused = await admit(message(text('漢'.repeat(34)))).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PartTooLargeError);
    // 33 characters, 99 bytes; and 100 ASCII characters: within it.
    const outcomes = await Promise.allSettled([
      admit(message(text('漢'.repeat(33)))),
      admit(message(text('a'.repeat(100)))),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
