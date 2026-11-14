/**
 * A core harness for tests: the real loop, the real step implementations, the real
 * context builder and the in-memory stores, driven by a scripted model. No protocol
 * layer, no network.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { createBuiltinTools } from '../../src/harness/core/builtin-tools.ts';
import type { StepHandlers } from '../../src/harness/core/direct-runner.ts';
import { DirectRunner } from '../../src/harness/core/direct-runner.ts';
import { runTask } from '../../src/harness/core/loop.ts';
import { createMemoryPersistence } from '../../src/harness/core/memory-persistence.ts';
import type { Persistence } from '../../src/harness/core/persistence.ts';
import type { InboxItemRef, TransitionResult } from '../../src/harness/core/step-runner.ts';
import type { StepDeps } from '../../src/harness/core/steps.ts';
import { createStepHandlers } from '../../src/harness/core/steps.ts';
import type { ContentPart, InboxPayload } from '../../src/harness/core/types.ts';
import { definePrompt } from '../../src/harness/system-prompt/prompt.ts';
import type { Tool } from '../../src/harness/tools/types.ts';
import { assetPath } from '../../src/kernel/assets.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { EntityRegistry } from '../../src/kernel/registry.ts';
import type { MemoryTaskInit } from '../../src/testing/memory-task-port.ts';
import { MemoryTaskPort } from '../../src/testing/memory-task-port.ts';
import type { ScriptedTurn } from '../../src/testing/scripted-llm.ts';
import { ScriptedLlm } from '../../src/testing/scripted-llm.ts';

/** Options of {@link createCore}. */
export interface CoreOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly tools?: readonly Tool[];
  readonly task?: Partial<MemoryTaskInit>;
  readonly maxIterations?: number;
  readonly maxTaskTokens?: number;
  readonly llmDelayMs?: number;
  readonly usagePerCall?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly deps?: Partial<StepDeps>;
  readonly contextWindow?: number;
  /** Record steps and inbox reads in the journal, so a second runner can replay them. */
  readonly journaled?: boolean;
}

/** A running core, with the handles a test needs. */
export interface Core {
  readonly taskId: string;
  readonly llm: ScriptedLlm;
  readonly registry: EntityRegistry;
  readonly persistence: Persistence;
  readonly tasks: MemoryTaskPort;
  readonly runner: DirectRunner;
  readonly handlers: StepHandlers;
  readonly deltas: string[];
  /** Tool activity as `<name> <phase>`, in order. */
  readonly activities: string[];
  /** Resolves when the task reaches a terminal state. */
  readonly finished: Promise<TransitionResult>;
  /** Puts a message in the inbox and hands it to the run. */
  send(text: string, options?: { interrupt?: boolean }): Promise<string>;
  /** Puts any payload in the inbox and hands it to the run. */
  deliver(payload: InboxPayload, options?: { interrupt?: boolean }): Promise<string>;
  /** Resolves once the task's status history has `count` entries. */
  statuses(count: number): Promise<MemoryTaskPort['history']>;
  /** The text of every conversation event, in order, as `role: text`. */
  transcript(): Promise<string[]>;
}

async function registerPrompts(registry: EntityRegistry): Promise<void> {
  const dir = assetPath('prompts');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).toSorted();
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of small files
    const template = await readFile(`${dir}/${file}`, 'utf8');
    registry.register(definePrompt({ id: basename(file, '.md'), template }));
  }
}

function textOf(parts: readonly ContentPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('');
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

/** Builds a core and starts the task's run. */
export async function createCore(options: CoreOptions = {}): Promise<Core> {
  const taskId = options.task?.taskId ?? 't1';
  const registry = new EntityRegistry();
  await registerPrompts(registry);
  const persistence = createMemoryPersistence();
  const llm = new ScriptedLlm(options.turns ?? [], {
    ...(options.llmDelayMs === undefined ? {} : { delayMs: options.llmDelayMs }),
    ...(options.usagePerCall === undefined ? {} : { usagePerCall: options.usagePerCall }),
    ...(options.contextWindow === undefined
      ? {}
      : { capabilities: { contextWindow: options.contextWindow } }),
  });
  registry.register(llm);
  for (const tool of [...createBuiltinTools(persistence), ...(options.tools ?? [])]) {
    registry.register(tool);
  }
  const tasks = new MemoryTaskPort();
  tasks.create({ ...options.task, taskId });
  const deltas: string[] = [];
  const activities: string[] = [];
  const handlers = createStepHandlers({
    registry,
    persistence,
    tasks,
    sink: {
      delta: (_task, _key, text) => {
        deltas.push(text);
      },
      reset: () => {
        deltas.length = 0;
      },
      activity: (_task, activity) => {
        activities.push(`${activity.name} ${activity.phase}`);
      },
    },
    redactor: new Redactor(),
    defaultLlm: llm.ref.id,
    compactionThreshold: 0.8,
    toolTimeoutMs: 2000,
    ...options.deps,
  });
  const runner = new DirectRunner(
    taskId,
    handlers,
    {
      maxIterations: options.maxIterations ?? 50,
      maxTaskTokens: options.maxTaskTokens ?? 2_000_000,
    },
    options.journaled === true ? { journal: persistence.journal } : {},
  );
  let counter = 0;
  const deliver: Core['deliver'] = async (payload, deliverOptions = {}) => {
    counter += 1;
    const id = `m${String(counter)}`;
    const interrupt = deliverOptions.interrupt ?? false;
    await persistence.inbox.put({
      id,
      taskId,
      receivedAt: '2026-01-01T00:00:00.000Z',
      interrupt,
      payload,
    });
    const ref: InboxItemRef = { id, kind: payload.kind, interrupt };
    runner.deliver(ref);
    return id;
  };
  return {
    taskId,
    llm,
    registry,
    persistence,
    tasks,
    runner,
    handlers,
    deltas,
    activities,
    finished: runTask(runner),
    deliver,
    send: (text, sendOptions = {}) =>
      deliver({ kind: 'message', parts: [{ type: 'text', text }] }, sendOptions),
    statuses: async (count) => {
      await until(() => tasks.history.length >= count, `${String(count)} status updates`);
      return tasks.history;
    },
    transcript: async () =>
      (await persistence.conversation.read(taskId)).map((event) => {
        switch (event.type) {
          case 'message': {
            return `${event.role}: ${textOf(event.parts)}`;
          }
          case 'tool-call': {
            return `call ${event.call.id}: ${event.call.name}`;
          }
          case 'tool-result': {
            return `result ${event.callId}: ${
              event.result.ok ? textOf(event.result.content) : `error ${event.result.error.code}`
            }`;
          }
          default: {
            return event.type;
          }
        }
      }),
  };
}

/** The last status in a history. */
export function last<T>(items: readonly T[]): T | undefined {
  return items.at(-1);
}
