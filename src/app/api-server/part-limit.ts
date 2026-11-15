/**
 * The size limit on the binary and text parts of a message, as an admission check. The
 * HTTP listener already refuses an oversized part before the body is parsed; this holds
 * the same limit for a caller that reaches the request handler without a listener — the
 * browser build calls it in memory — so an image, a recording or a text over the limit is
 * never stored, whichever way it came in. Text is measured in UTF-8 bytes.
 */
import type { Message, Part } from '@a2a-js/sdk';

import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { Admission } from './admission.ts';

/** A message carries a part larger than `limits.max_part_bytes`. */
export class PartTooLargeError extends YaahError {
  readonly limit: number;

  constructor(limit: number) {
    super('limit.part-size', t('server.limit.part-size', { limit }));
    this.limit = limit;
  }
}

const utf8 = new TextEncoder();

/** The size of a part's content in bytes: its bytes, or its text as UTF-8. */
function sizeOf(part: Part): number {
  const { content } = part;
  if (content?.$case === 'raw') {
    return content.value.length;
  }
  return content?.$case === 'text' ? utf8.encode(content.value).length : 0;
}

/** Refuses a message with a `raw` or `text` part of more than `maxPartBytes` bytes. */
export function partSizeAdmission(maxPartBytes: number): Admission {
  return (message: Message): Promise<void> => {
    const oversized = message.parts.some((part: Part) => sizeOf(part) > maxPartBytes);
    return oversized ? Promise.reject(new PartTooLargeError(maxPartBytes)) : Promise.resolve();
  };
}
