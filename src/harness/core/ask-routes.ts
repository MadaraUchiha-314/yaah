/**
 * Ask routes: how a tool other than `ask_user` puts a question to the person on the
 * task's own conversation. A route looks at a call the model made and may claim it as
 * such a question; the loop then treats it exactly as it treats `ask_user` — the task
 * rests in `input-required`, and the reply becomes the result of that very call.
 *
 * The suspension itself stays where it is, in the loop. A route only says which calls
 * are questions.
 */
import type { StepHandlers } from './direct-runner.ts';
import { ASK_USER } from './loop.ts';
import type { TaskId, ToolCall } from './types.ts';

/**
 * Decides whether `call`, made on task `taskId`, is a question for the task's own
 * conversation. Returns the question to ask, or null when the call is not one.
 */
export type AskRoute = (taskId: TaskId, call: ToolCall) => Promise<string | null>;

async function reroute(
  routes: ReadonlySet<AskRoute>,
  taskId: TaskId,
  call: ToolCall,
): Promise<ToolCall> {
  if (call.name === ASK_USER) {
    return call;
  }
  for (const route of routes) {
    // oxlint-disable-next-line no-await-in-loop -- the first route that claims the call wins
    const question = await route(taskId, call);
    if (question !== null) {
      // Same id: the conversation keeps the call the model made, and the answer is its result.
      return { id: call.id, name: ASK_USER, args: { question } };
    }
  }
  return call;
}

/**
 * Returns step implementations whose model call reports a claimed tool call to the loop
 * as `ask_user`. The set is read at call time, so a route added later applies to running
 * tasks. What is stored in the conversation is untouched.
 */
export function withAskRoutes(handlers: StepHandlers, routes: ReadonlySet<AskRoute>): StepHandlers {
  return {
    ...handlers,
    'llm.invoke': async (ctx, input) => {
      const output = await handlers['llm.invoke'](ctx, input);
      if (routes.size === 0) {
        return output;
      }
      const toolCalls = await Promise.all(
        output.toolCalls.map((call: ToolCall) => reroute(routes, ctx.taskId, call)),
      );
      return { ...output, toolCalls };
    },
  };
}
