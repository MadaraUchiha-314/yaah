/**
 * Which of an agent's tasks a task may write into: those it handed to that agent. A piece
 * of work is recorded among the task's sub-tasks; a task an agent opened to answer a
 * question is remembered in the task's state. A `taskId` the model names is checked
 * against both, so it cannot post into a task it did not start.
 */
import type { StateStore } from '../core/persistence.ts';
import type { TaskPort } from '../core/task-port.ts';
import type { StepKey, TaskId, TaskRef } from '../core/types.ts';

/**
 * Prefix of the state names under which a task keeps the agent tasks its questions opened:
 * one name per task, so that parallel calls each write their own and none is lost.
 */
export const ASKED_TASKS = 'yaah.asked-tasks';

/** What the checks read. */
export interface DelegatedDeps {
  readonly tasks: TaskPort;
  readonly state: StateStore;
}

function askedName(agent: string, taskId: string): string {
  return `${ASKED_TASKS}:${JSON.stringify([agent, taskId])}`;
}

/** Whether `taskId` is a task of `agent`'s that the task `parent` handed it. */
export async function delegatedTo(
  deps: DelegatedDeps,
  parent: TaskId,
  agent: string,
  taskId: string,
): Promise<boolean> {
  const { model } = await deps.tasks.load(parent);
  if (model.subTasks.some((ref: TaskRef) => ref.taskId === taskId && ref.agent === agent)) {
    return true;
  }
  return (await deps.state.get(parent, askedName(agent, taskId))) === true;
}

/** Remembers that a question of the task `parent`, made in step `key`, opened `ref`. */
export async function rememberAsked(
  deps: DelegatedDeps,
  parent: TaskId,
  key: StepKey,
  ref: TaskRef,
): Promise<void> {
  await deps.state.set(parent, key, askedName(ref.agent, ref.taskId), true);
}
