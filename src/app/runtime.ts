/**
 * The app runtime plugin: the stream hub, the task store, the task port and the step
 * implementations — everything a durable-execution mode needs to run task loops.
 * Provides the `taskRuntime` service.
 */
import type { Context } from 'cordis';

import { createCompactor } from '../harness/core/context/compaction.ts';
import type { StepHandlers } from '../harness/core/direct-runner.ts';
import type { RunLimits } from '../harness/core/step-runner.ts';
import type { TurnExtension } from '../harness/core/steps.ts';
import { createStepHandlers } from '../harness/core/steps.ts';
import type { TaskSnapshot } from '../harness/core/task-port.ts';
import { A2aTaskPort } from './api-server/task-port.ts';
import type { YaahTaskStore } from './api-server/task-store.ts';
import { MemoryTaskStore, SqliteTaskStore } from './api-server/task-store.ts';
import { StreamHub } from './stream-hub.ts';

/** What a durable-execution mode is given to run tasks with. */
export interface RuntimeService {
  readonly hub: StreamHub;
  readonly taskStore: YaahTaskStore;
  readonly tasks: A2aTaskPort;
  readonly handlers: StepHandlers;
  readonly limits: RunLimits;
  /**
   * Adds something to every turn: a function that, given the task, returns a turn
   * extension or null when it does not apply. Returns a function that removes it.
   */
  addTurnExtension(provide: TurnExtensionProvider): () => void;
}

/** Decides, per task and turn, whether a turn extension applies. */
export type TurnExtensionProvider = (task: TaskSnapshot) => TurnExtension | null;

declare module 'cordis' {
  interface Context {
    /** The pieces task loops run on. */
    taskRuntime: RuntimeService;
  }
  interface Events {
    /** A conversation was compacted. */
    'context/compacted'(taskId: string, before: number, after: number): void;
  }
}

/** How long one tool call may take before it is reported to the model as timed out. */
const TOOL_TIMEOUT_MS = 120_000;

export const name = 'runtime';
export const inject: readonly string[] = ['entities', 'config', 'redactor', 'persistence'];

/** Builds the runtime. */
export function apply(ctx: Context): void {
  const { config, persistence } = ctx;
  const hub = new StreamHub();
  const taskStore =
    persistence.database === null
      ? new MemoryTaskStore()
      : new SqliteTaskStore(persistence.database);
  const tasks = new A2aTaskPort(taskStore, hub);
  const shared = { registry: ctx.entities, persistence, tasks, defaultLlm: config.model.llm };
  const providers = new Set<TurnExtensionProvider>();
  const handlers = createStepHandlers({
    ...shared,
    turnExtensions: (task: TaskSnapshot): TurnExtension[] =>
      [...providers]
        .map((provide: TurnExtensionProvider) => provide(task))
        .filter((extension: TurnExtension | null) => extension !== null),
    sink: hub,
    redactor: ctx.redactor,
    defaultEffort: config.model.effort,
    compactionThreshold: config.compaction.threshold,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
    compact: createCompactor({
      ...shared,
      keepRecentFraction: config.compaction.keepRecentFraction,
      onCompacted: (taskId: string, before: number, after: number): void => {
        ctx.emit('context/compacted', taskId, before, after);
      },
    }),
  });
  ctx.provide('taskRuntime', {
    hub,
    taskStore,
    tasks,
    handlers,
    addTurnExtension: (provide: TurnExtensionProvider): (() => void) => {
      providers.add(provide);
      return (): void => {
        providers.delete(provide);
      };
    },
    limits: {
      maxIterations: config.limits.maxIterations,
      maxTaskTokens: config.limits.maxTaskTokens,
    },
  });
}
