/**
 * Which of an agent's tasks a task may write into: those it handed to that agent. A piece
 * of work is recorded among the task's sub-tasks; a task an agent opened to answer a
 * question is remembered in the task's state. A `taskId` the model names is checked
 * against both, so it cannot post into a task it did not start.
 */
import type { Json } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import type { StateStore } from '../core/persistence.ts';
import type { TaskPort } from '../core/task-port.ts';
import type { StepKey, TaskId, TaskRef } from '../core/types.ts';

/** State name under which a task keeps the agent tasks its questions opened. */
export const ASKED_TASKS = 'yaah.asked-tasks';

/** What the checks read. */
export interface DelegatedDeps {
  readonly tasks: TaskPort;
  readonly state: StateStore;
}

/** One agent task a question opened, as kept in the state. */
interface Asked {
  readonly taskId: string;
  readonly agent: string;
}

function askedOf(value: Json | undefined): Asked[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: Json): Asked[] =>
    isJsonObject(entry) && typeof entry['taskId'] === 'string' && typeof entry['agent'] === 'string'
      ? [{ taskId: entry['taskId'], agent: entry['agent'] }]
      : [],
  );
}

/** Whether `taskId` is a task of `agent`'s that the task `parent` handed it. */
export async function delegatedTo(
  deps: DelegatedDeps,
  parent: TaskId,
  agent: string,
  taskId: string,
): Promise<boolean> {
  const same = (ref: Asked): boolean => ref.taskId === taskId && ref.agent === agent;
  const { model } = await deps.tasks.load(parent);
  if (model.subTasks.some((ref: TaskRef) => same(ref))) {
    return true;
  }
  return askedOf(await deps.state.get(parent, ASKED_TASKS)).some((ref: Asked) => same(ref));
}

/** Remembers that a question of the task `parent`, made in step `key`, opened `ref`. */
export async function rememberAsked(
  deps: DelegatedDeps,
  parent: TaskId,
  key: StepKey,
  ref: TaskRef,
): Promise<void> {
  const known = askedOf(await deps.state.get(parent, ASKED_TASKS));
  if (!known.some((entry: Asked) => entry.taskId === ref.taskId && entry.agent === ref.agent)) {
    const next: Json = [...known, ref].map((entry: Asked) => ({
      taskId: entry.taskId,
      agent: entry.agent,
    }));
    await deps.state.set(parent, key, ASKED_TASKS, next);
  }
}
