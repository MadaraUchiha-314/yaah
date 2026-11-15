/** What a message sent to a task means to its inbox. */
import type { Message, Task } from '@a2a-js/sdk';

import type { InboxPayload } from '../../harness/core/types.ts';
import type { JsonObject } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import { partsFromA2a } from './convert.ts';
import { A2A_EVENT_MEDIA_TYPE, EXT, SCHEMAS, readExtension } from './extensions/index.ts';
import { readTaskModel } from './task-port.ts';

/** The inbox payload a message carries: a lifecycle action, a sub-task event, or content. */
export function payloadOf(message: Message): InboxPayload {
  const lifecycle = readExtension(
    message.metadata,
    EXT.taskLifecycle,
    SCHEMAS.taskLifecycleRequest,
  );
  if (lifecycle?.action === 'complete') {
    return { kind: 'action', action: 'complete' };
  }
  const parts = partsFromA2a(message.parts);
  const event = parts.find(
    (part) => part.type === 'data' && part.mediaType === A2A_EVENT_MEDIA_TYPE,
  );
  if (event?.type === 'data' && isJsonObject(event.data)) {
    return { kind: 'event', event: event.data };
  }
  return { kind: 'message', parts };
}

/** Whether `event` is about a sub-task of `task`, matched on task id and context id. */
export function isFromDelegate(task: Task, event: JsonObject): boolean {
  const subject = Object.values(event).find((value) => isJsonObject(value));
  const fields = subject !== undefined && isJsonObject(subject) ? subject : {};
  const taskId = fields['taskId'] ?? fields['id'];
  const contextId = fields['contextId'];
  return readTaskModel(task).subTasks.some(
    (ref) => ref.taskId === taskId && ref.contextId === contextId,
  );
}
