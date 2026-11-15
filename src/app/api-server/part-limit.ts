/**
 * The size limit on the binary parts of a message, as an admission check. The HTTP
 * listener already refuses an oversized part before the body is parsed; this holds the
 * same limit for a caller that reaches the request handler without a listener — the
 * browser build calls it in memory — so an image or a recording over the limit is never
 * stored, whichever way it came in.
 */
import type { Message } from '@a2a-js/sdk';

import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { Admission } from './admission.ts';

/** A message carries a binary part larger than `limits.max_part_bytes`. */
export class PartTooLargeError extends YaahError {
  readonly limit: number;

  constructor(limit: number) {
    super('limit.part-size', t('server.limit.part-size', { limit }));
    this.limit = limit;
  }
}

/** Refuses a message with a `raw` part of more than `maxPartBytes` bytes. */
export function partSizeAdmission(maxPartBytes: number): Admission {
  return (message: Message): Promise<void> => {
    const oversized = message.parts.some(
      (part) => part.content?.$case === 'raw' && part.content.value.length > maxPartBytes,
    );
    return oversized ? Promise.reject(new PartTooLargeError(maxPartBytes)) : Promise.resolve();
  };
}
