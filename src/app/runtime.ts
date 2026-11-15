/**
 * The app runtime plugin: the stream hub, the task store, the task port and the step
 * implementations — everything a durable-execution mode needs to run task loops.
 * Provides the `taskRuntime` service.
 */
import type { Context } from 'cordis';

import type { AskRoute } from '../harness/core/ask-routes.ts';
import { withAskRoutes } from '../harness/core/ask-routes.ts';
import type { SkillsSection } from '../harness/core/context/builder.ts';
import { createCompactor } from '../harness/core/context/compaction.ts';
import type { StepHandlers } from '../harness/core/direct-runner.ts';
import type { StepMiddleware } from '../harness/core/step-middleware.ts';
import { withMiddleware } from '../harness/core/step-middleware.ts';
import type { RunLimits } from '../harness/core/step-runner.ts';
import type { TurnExtension } from '../harness/core/steps.ts';
import { createStepHandlers } from '../harness/core/steps.ts';
import type { TaskSnapshot } from '../harness/core/task-port.ts';
import type { SpeechDeps } from '../harness/core/voice.ts';
import type { ToolCall, ToolError } from '../harness/core/types.ts';
import type { ToolGuard } from '../harness/tools/execute.ts';
import type { ToolCallContext } from '../harness/tools/types.ts';
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
  /**
   * Runs `middleware` around every step of every task from now on — how logging and
   * tracing see the loop. Returns a function that removes it.
   */
  addStepMiddleware(middleware: StepMiddleware): () => void;
  /**
   * Lets a tool put its question to the person on the task's own conversation, the way
   * `ask_user` does. Returns a function that removes the route.
   */
  addAskRoute(route: AskRoute): () => void;
  /**
   * Sets what fills the skills position of the context — the names and descriptions of
   * the registered skills. Returns a function that empties the position again.
   */
  setSkills(section: SkillsSection): () => void;
  /**
   * Adds a check made before every tool call, after its arguments passed their schema.
   * Guards are asked in the order they were added and the first refusal stands: the tool
   * does not run and the model is shown the error. Returns a function that removes it.
   */
  addToolGuard(guard: ToolGuard): () => void;
  /**
   * Sets the speech models: the one that transcribes audio turns and the one that speaks
   * answers. Returns a function that takes them away again.
   */
  setSpeech(speech: SpeechDeps): () => void;
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

/** Asks each guard in turn; the first refusal is the answer. */
async function firstRefusal(
  guards: ReadonlySet<ToolGuard>,
  call: ToolCall,
  about: Omit<ToolCallContext, 'callId'>,
): Promise<ToolError | null> {
  for (const guard of guards) {
    // oxlint-disable-next-line no-await-in-loop -- guards are asked in order; the first refusal ends it
    const refused = await guard(call, about);
    if (refused !== null) {
      return refused;
    }
  }
  return null;
}

/** Builds the function that adds an item to `set` and returns the function removing it. */
function adderTo<T>(set: Set<T>): (item: T) => () => void {
  return (item: T): (() => void) => {
    set.add(item);
    return (): void => {
      set.delete(item);
    };
  };
}

/** The speech models in use, settable after the steps were built around them. */
function speechHolder(): { deps: SpeechDeps; set: (speech: SpeechDeps) => () => void } {
  let current: SpeechDeps | null = null;
  return {
    deps: {
      stt: () => current?.stt() ?? null,
      tts: (task: TaskSnapshot) => current?.tts(task) ?? null,
      onError: (taskId: string, error: unknown): void => current?.onError?.(taskId, error),
    },
    set: (speech: SpeechDeps): (() => void) => {
      current = speech;
      return (): void => {
        current = current === speech ? null : current;
      };
    },
  };
}

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
  const middlewares = new Set<StepMiddleware>();
  const askRoutes = new Set<AskRoute>();
  const guards = new Set<ToolGuard>();
  let skills: SkillsSection | null = null;
  const speech = speechHolder();
  const steps = createStepHandlers({
    ...shared,
    turnExtensions: (task: TaskSnapshot): TurnExtension[] =>
      [...providers]
        .map((provide: TurnExtensionProvider) => provide(task))
        .filter((extension: TurnExtension | null) => extension !== null),
    skills: (): string => skills?.() ?? '',
    toolGuard: (call: ToolCall, about: Omit<ToolCallContext, 'callId'>) =>
      firstRefusal(guards, call, about),
    sink: hub,
    speech: speech.deps,
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
    handlers: withMiddleware(withAskRoutes(steps, askRoutes), middlewares),
    addAskRoute: adderTo(askRoutes),
    addStepMiddleware: adderTo(middlewares),
    setSkills: (section: SkillsSection): (() => void) => {
      skills = section;
      return (): void => {
        skills = skills === section ? null : skills;
      };
    },
    addToolGuard: adderTo(guards),
    setSpeech: speech.set,
    addTurnExtension: adderTo(providers),
    limits: {
      maxIterations: config.limits.maxIterations,
      maxTaskTokens: config.limits.maxTaskTokens,
    },
  });
}
