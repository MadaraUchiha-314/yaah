/**
 * The app runtime plugin: the stream hub, the task store, the task port and the step
 * implementations — everything a durable-execution mode needs to run task loops.
 * Provides the `taskRuntime` service.
 */
import type { Context } from 'cordis';

import { createCompactor } from '../harness/core/context/compaction.ts';
import type { StepHandlers } from '../harness/core/direct-runner.ts';
import type { RunLimits } from '../harness/core/step-runner.ts';
import { createStepHandlers } from '../harness/core/steps.ts';
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
}

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
  const handlers = createStepHandlers({
    ...shared,
    sink: hub,
    redactor: ctx.redactor,
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
    limits: {
      maxIterations: config.limits.maxIterations,
      maxTaskTokens: config.limits.maxTaskTokens,
    },
  });
}
