/**
 * Durable execution on Temporal: each task is a workflow, each step an activity. The
 * worker runs in this process, beside the API server, so what a step streams reaches
 * the clients exactly as in the in-process mode.
 */
import { fileURLToPath } from 'node:url';

import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';

import type { StepHandlers } from '../../../harness/core/direct-runner.ts';
import type {
  InboxItemRef,
  RetryPolicy,
  RunLimits,
  StepName,
} from '../../../harness/core/step-runner.ts';
import type { TaskId } from '../../../harness/core/types.ts';
import type { DurableMode } from '../../../kernel/config-types.ts';
import type { DurableExecution } from '../types.ts';
import { createActivities } from './activities.ts';
import type { TemporalLink } from './connection.ts';
import type { TaskWorkflowInput } from './protocol.ts';
import { CANCEL_SIGNAL, INBOX_SIGNAL, TASK_WORKFLOW, workflowIdOf } from './protocol.ts';

/** What the Temporal mode works with. */
export interface TemporalDeps {
  readonly mode: Exclude<DurableMode, 'none'>;
  readonly link: TemporalLink;
  readonly taskQueue: string;
  readonly handlers: StepHandlers;
  readonly limits: RunLimits;
  readonly retry: RetryPolicy;
  readonly isRetrySafe: (name: StepName, input: unknown) => boolean;
  /** Whether closing this mode also closes the link. False when the link is shared. */
  readonly ownsLink?: boolean | undefined;
}

/** The workflow bundle's entry file. */
const WORKFLOWS_PATH = fileURLToPath(new URL('./workflow.ts', import.meta.url));

/** The Temporal implementation of {@link DurableExecution}. */
export class TemporalDurable implements DurableExecution {
  readonly mode: Exclude<DurableMode, 'none'>;
  readonly #deps: TemporalDeps;
  readonly #client: Client;
  readonly #worker: Worker;
  readonly #running: Promise<void>;

  private constructor(deps: TemporalDeps, worker: Worker) {
    this.mode = deps.mode;
    this.#deps = deps;
    this.#worker = worker;
    this.#client = new Client({ connection: deps.link.connection, namespace: deps.link.namespace });
    this.#running = worker.run();
  }

  /** Starts a worker for the task queue and returns the running mode. */
  static async start(deps: TemporalDeps): Promise<TemporalDurable> {
    const worker = await Worker.create({
      connection: deps.link.nativeConnection,
      namespace: deps.link.namespace,
      taskQueue: deps.taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: { ...createActivities(deps.handlers, deps.isRetrySafe) },
    });
    return new TemporalDurable(deps, worker);
  }

  async deliver(taskId: TaskId, item: InboxItemRef): Promise<void> {
    // A signal is recorded by Temporal even when no worker is running: that is what makes
    // the inbox durable in this mode.
    await this.#signal(taskId, INBOX_SIGNAL, [item]);
  }

  async cancel(taskId: TaskId): Promise<void> {
    await this.#signal(taskId, CANCEL_SIGNAL, []);
  }

  /** Nothing to do: Temporal resumes its workflows by itself once a worker polls. */
  recover(): Promise<void> {
    return Promise.resolve();
  }

  dashboard(): { readonly url: string } {
    return { url: this.#deps.link.dashboardUrl };
  }

  taskUrl(taskId: TaskId): string {
    return `${this.#deps.link.dashboardUrl}/workflows/${encodeURIComponent(workflowIdOf(taskId))}`;
  }

  async close(): Promise<void> {
    this.#worker.shutdown();
    await this.#running;
    if (this.#deps.ownsLink !== false) {
      await this.#deps.link.close();
    }
  }

  async #signal(taskId: TaskId, signal: string, signalArgs: unknown[]): Promise<void> {
    const input: TaskWorkflowInput = {
      taskId,
      limits: this.#deps.limits,
      retry: this.#deps.retry,
    };
    await this.#client.workflow.signalWithStart(TASK_WORKFLOW, {
      workflowId: workflowIdOf(taskId),
      taskQueue: this.#deps.taskQueue,
      args: [input],
      signal,
      signalArgs,
    });
  }
}
