/**
 * The core loop. One call to {@link runTask} is one task's whole life: wake on input,
 * think, act, answer, wait again — until the task reaches a terminal state.
 *
 * This file performs no I/O and reads no clock. It must stay that way: the same function
 * is bundled as a Temporal workflow, where determinism is what makes replay correct.
 */
import { isJsonObject } from '../../kernel/json.ts';
import type {
  InboxItemRef,
  RunPosition,
  StepName,
  StepRunner,
  TransitionResult,
} from './step-runner.ts';
import {
  LimitError,
  RunAbandonedError,
  TaskCancelledError,
  TurnInterruptedError,
} from './step-runner.ts';
import type { StepKey, ToolCall } from './types.ts';

/** The name of the tool the model calls to ask a person for input. */
export const ASK_USER = 'ask_user';

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'canceled', 'failed']);

/** Mutable bookkeeping of one run. Deterministic: derived only from step results. */
interface Run {
  readonly runner: StepRunner;
  sequence: number;
  tokens: number;
}

function nextKey(run: Run, name: StepName, detail = ''): StepKey {
  const key = `${run.runner.taskId}/${String(run.sequence)}/${name}/${detail}`;
  run.sequence += 1;
  return key;
}

function isComplete(item: InboxItemRef): boolean {
  return item.kind === 'action';
}

function questionOf(call: ToolCall): string {
  const question = isJsonObject(call.args) ? call.args['question'] : undefined;
  return typeof question === 'string' ? question : '';
}

/** Moves items into the conversation. Returns true when one of them ends the task. */
async function accept(run: Run, items: readonly InboxItemRef[]): Promise<boolean> {
  const content = items.filter((item: InboxItemRef) => !isComplete(item));
  if (content.length > 0) {
    await run.runner.step('conversation.accept', nextKey(run, 'conversation.accept'), {
      itemIds: content.map((item: InboxItemRef) => item.id),
    });
  }
  return items.some((item: InboxItemRef) => isComplete(item));
}

/**
 * The next message from a person, or the client's action ending the task. A sub-task's
 * event that arrives meanwhile is not an answer: it joins the conversation as an event.
 */
async function nextAnswer(run: Run): Promise<InboxItemRef> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- items arrive one after another
    const item = await run.runner.nextInboxItem();
    if (item.kind !== 'event') {
      return item;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await accept(run, [item]);
  }
}

/** Suspends the loop on the model's question and stores the reply as the call's result. */
async function askUser(run: Run, call: ToolCall): Promise<boolean> {
  await run.runner.step('task.transition', nextKey(run, 'task.transition'), {
    reason: 'ask-user',
    callId: call.id,
    question: questionOf(call),
  });
  const answer = await nextAnswer(run);
  if (isComplete(answer)) {
    return true;
  }
  await run.runner.step('conversation.accept', nextKey(run, 'conversation.accept'), {
    itemIds: [answer.id],
    asResultOf: call.id,
  });
  await run.runner.step('task.transition', nextKey(run, 'task.transition'), {
    reason: 'turn-start',
  });
  return false;
}

/** One model call and the tool calls it asked for. Returns the calls, or null if interrupted. */
async function iterate(run: Run): Promise<readonly ToolCall[] | null> {
  try {
    return await run.runner.interruptible(async () => {
      const built = await run.runner.step('context.build', nextKey(run, 'context.build'), {});
      if (built.compact) {
        await run.runner.step('context.compact', nextKey(run, 'context.compact'), {});
      }
      const reply = await run.runner.step('llm.invoke', nextKey(run, 'llm.invoke'), {});
      run.tokens += reply.usage.inputTokens + reply.usage.outputTokens;
      const ask = reply.toolCalls.find((call: ToolCall) => call.name === ASK_USER);
      await Promise.all(
        reply.toolCalls
          .filter((call: ToolCall) => call !== ask)
          .map((call: ToolCall) =>
            run.runner.step('tool.invoke', nextKey(run, 'tool.invoke', call.id), { call }),
          ),
      );
      return reply.toolCalls;
    });
  } catch (error) {
    if (error instanceof TurnInterruptedError) {
      return null;
    }
    throw error;
  }
}

/**
 * Works one turn: iterates until the model asks for nothing more and nothing is unread.
 *
 * @returns true when a client's lifecycle action ended the task during the turn.
 */
async function turn(run: Run): Promise<boolean> {
  const { limits } = run.runner;
  for (let iteration = 0; ; iteration += 1) {
    if (iteration >= limits.maxIterations) {
      throw new LimitError('iterations', limits.maxIterations);
    }
    if (run.tokens >= limits.maxTaskTokens) {
      throw new LimitError('tokens', limits.maxTaskTokens);
    }
    // Late arrivals are read at every iteration, so the model always sees them next.
    // oxlint-disable-next-line no-await-in-loop -- iterations are sequential by nature
    if (await accept(run, await run.runner.drainInbox())) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const calls = await iterate(run);
    const ask = calls?.find((call: ToolCall) => call.name === ASK_USER);
    if (ask !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (await askUser(run, ask)) {
        return true;
      }
    } else if (calls !== null && calls.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const unread = await run.runner.drainInbox();
      if (unread.length === 0) {
        return false;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (await accept(run, unread)) {
        return true;
      }
    }
  }
}

function finish(run: Run, reason: 'client-complete'): Promise<TransitionResult> {
  return run.runner.step('task.transition', nextKey(run, 'task.transition'), { reason });
}

async function life(run: Run): Promise<TransitionResult> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a task's turns are sequential
    await run.runner.checkpoint?.({ sequence: run.sequence, tokens: run.tokens });
    // oxlint-disable-next-line no-await-in-loop -- as above
    const item = await run.runner.nextInboxItem();
    if (isComplete(item)) {
      return finish(run, 'client-complete');
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await run.runner.step('task.transition', nextKey(run, 'task.transition'), {
      reason: 'turn-start',
    });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await accept(run, [item]);
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (await turn(run)) {
      return finish(run, 'client-complete');
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const next = await run.runner.step('task.transition', nextKey(run, 'task.transition'), {
      reason: 'turn-complete',
    });
    if (TERMINAL.has(next.state)) {
      return next;
    }
  }
}

/**
 * Runs a task from its first inbox item to a terminal state.
 *
 * Cancellation and failure are outcomes, not exceptions: whatever happens, the final
 * status is recorded in a shielded step and returned. The one exception is a shutdown.
 *
 * @throws RunAbandonedError when the runner is abandoned; nothing is recorded.
 *
 * @param start Where a run that continues an earlier one resumes its step numbering and
 *   its token count.
 */
export async function runTask(runner: StepRunner, start?: RunPosition): Promise<TransitionResult> {
  const run: Run = { runner, sequence: start?.sequence ?? 0, tokens: start?.tokens ?? 0 };
  try {
    const outcome = await life(run);
    return outcome;
  } catch (error) {
    if (error instanceof RunAbandonedError) {
      throw error;
    }
    const request =
      error instanceof TaskCancelledError
        ? ({ reason: 'cancel' } as const)
        : ({
            reason: 'error',
            cause: error instanceof Error ? error.message : String(error),
          } as const);
    const final = await runner.shielded(() =>
      runner.step('task.transition', nextKey(run, 'task.transition'), request),
    );
    return final;
  }
}
