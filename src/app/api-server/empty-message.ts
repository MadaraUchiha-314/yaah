/**
 * Refuses a message that says nothing, as an admission check: no text besides white
 * space, no file, no data, and no instruction for the task's lifecycle. Without it such
 * a message would start a turn and cost a model call.
 */
import type { Message } from '@a2a-js/sdk';

import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { Admission } from './admission.ts';
import { EXT, SCHEMAS, readExtension } from './extensions/index.ts';

/** A message has no content and asks for nothing. */
export class EmptyMessageError extends YaahError {
  constructor() {
    super('message.empty', t('server.message.empty'));
  }
}

function saysSomething(message: Message): boolean {
  return message.parts.some((part) => {
    const { content } = part;
    return content !== undefined && (content.$case !== 'text' || content.value.trim() !== '');
  });
}

/** The admission check described above. */
export const emptyMessageAdmission: Admission = (message: Message): Promise<void> => {
  // A lifecycle message — "complete this task" — carries its meaning in metadata.
  const lifecycle = readExtension(
    message.metadata,
    EXT.taskLifecycle,
    SCHEMAS.taskLifecycleRequest,
  );
  return saysSomething(message) || lifecycle?.action !== undefined
    ? Promise.resolve()
    : Promise.reject(new EmptyMessageError());
};
