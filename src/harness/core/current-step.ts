/** Whether a step is still the task's current work when it is about to write. */
import type { StepContext } from './direct-runner.ts';
import type { ConversationStore } from './persistence.ts';
import type { TaskPort } from './task-port.ts';
import type { ConversationEvent } from './types.ts';

const ENDED: ReadonlySet<string> = new Set(['completed', 'canceled', 'failed']);

/** The sequence number in a step key, `<taskId>/<sequence>/<step>/<detail>`. */
function sequenceOf(key: string): number {
  return Number(key.split('/')[1]);
}

/**
 * Stops a step that was abandoned — its turn interrupted or its task cancelled — before
 * it writes. What an abandoned step produced must not appear in the conversation.
 *
 * The signal is not enough on its own: under Temporal an activity learns that it was
 * cancelled only at its next heartbeat, while the workflow has moved on. So the stores
 * are asked too: a step is abandoned when its task has ended, or when a later step has
 * already accepted new input into the conversation.
 *
 * @throws the signal's reason, or an Error, when the step was abandoned.
 */
export async function assertCurrent(
  tasks: TaskPort,
  conversation: ConversationStore,
  ctx: StepContext,
): Promise<void> {
  const abandoned = (): Error =>
    ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('step abandoned');
  if (ctx.signal.aborted) {
    throw abandoned();
  }
  const [task, events] = await Promise.all([tasks.load(ctx.taskId), conversation.read(ctx.taskId)]);
  const mine = sequenceOf(ctx.key);
  const overtaken = events.some(
    (event: ConversationEvent) =>
      event.key.split('/')[2] === 'conversation.accept' && sequenceOf(event.key) > mine,
  );
  if (overtaken || ENDED.has(task.state)) {
    throw abandoned();
  }
}
