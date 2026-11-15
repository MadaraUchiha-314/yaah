/**
 * Wraps the step implementations so that plugins can observe every step of every task —
 * to log it, to trace it — without the steps knowing about them.
 */
import type { StepContext, StepHandlers } from './direct-runner.ts';
import type { StepInput, StepName, StepOutput } from './step-runner.ts';
import type { StepKey, TaskId } from './types.ts';

/** One step about to be performed. */
export interface StepCall {
  readonly name: StepName;
  readonly taskId: TaskId;
  readonly key: StepKey;
  /** The step's input. Plain data; read it with a type guard. */
  readonly input: unknown;
}

/**
 * Runs around a step. It must call `next` exactly once and return what `next` returned
 * (or throw what it threw): a middleware observes a step, it does not change one.
 */
export type StepMiddleware = <T>(call: StepCall, next: () => Promise<T>) => Promise<T>;

function wrap<N extends StepName>(
  name: N,
  handler: (ctx: StepContext, input: StepInput<N>) => Promise<StepOutput<N>>,
  middlewares: ReadonlySet<StepMiddleware>,
): (ctx: StepContext, input: StepInput<N>) => Promise<StepOutput<N>> {
  return (ctx: StepContext, input: StepInput<N>): Promise<StepOutput<N>> => {
    const call: StepCall = { name, taskId: ctx.taskId, key: ctx.key, input };
    let next = (): Promise<StepOutput<N>> => handler(ctx, input);
    // The set is read at call time, so a middleware added later applies to running tasks.
    for (const middleware of [...middlewares].toReversed()) {
      const inner = next;
      next = (): Promise<StepOutput<N>> => middleware(call, inner);
    }
    return next();
  };
}

/**
 * Returns step implementations that pass through every middleware in `middlewares`, the
 * first added outermost.
 */
export function withMiddleware(
  handlers: StepHandlers,
  middlewares: ReadonlySet<StepMiddleware>,
): StepHandlers {
  return {
    'conversation.accept': wrap(
      'conversation.accept',
      handlers['conversation.accept'],
      middlewares,
    ),
    'context.build': wrap('context.build', handlers['context.build'], middlewares),
    'context.compact': wrap('context.compact', handlers['context.compact'], middlewares),
    'llm.invoke': wrap('llm.invoke', handlers['llm.invoke'], middlewares),
    'tool.invoke': wrap('tool.invoke', handlers['tool.invoke'], middlewares),
    'task.transition': wrap('task.transition', handlers['task.transition'], middlewares),
  };
}
