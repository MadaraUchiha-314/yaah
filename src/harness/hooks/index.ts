/**
 * The hooks plugin: provides the `hooks` service and connects its lifecycle points to
 * the harness —
 *
 * - `llm.before`, `llm.after`, `tool.after`, `task.transition`: a step middleware;
 * - `tool.before`, `agent.before`: a tool guard, asked before a call runs. A refused call
 *   is not executed; its tool result tells the model it was denied and why, and the task
 *   goes on. `agent.before` is asked for every tool that reaches an agent: `invoke_agent`
 *   and the two channel tools;
 * - `message.received`: an interceptor in front of the inbox. A refused message is
 *   answered with the reason and never reaches a model.
 */
import type { Message } from '@a2a-js/sdk';
import type { RequestContext } from '@a2a-js/sdk/server';
import type { Context } from 'cordis';
import { z } from 'zod';

import { agentMessage, messageText } from '../../app/api-server/convert.ts';
import type { Json } from '../../kernel/json.ts';
import { INVOKE_AGENT } from '../a2a/invoke-tool.ts';
import { CREATE_TASK_FOR_PARTICIPANT, MESSAGE_PARTICIPANT } from '../channels/tools.ts';
import type { StepCall, StepMiddleware } from '../core/step-middleware.ts';
import type { ToolCall, ToolError } from '../core/types.ts';
import type { ToolGuard } from '../tools/execute.ts';
import type { HookName } from './service.ts';
import { Hooks } from './service.ts';

export { BLOCKING_HOOKS, HOOK_NAMES, Hooks, globToRegExp } from './service.ts';
export type {
  Hook,
  HookDecision,
  HookEvents,
  HookFailureListener,
  HookName,
  HookResult,
} from './service.ts';

declare module 'cordis' {
  interface Context {
    /** Lifecycle hooks. */
    hooks: Hooks;
  }
  interface Events {
    /** A hook refused something. `subject` is the tool, the agent or the task concerned. */
    'hooks/denied'(event: HookName, subject: string, reason: string): void;
    /** A hook threw. At a blocking point that refused what it was asked about. */
    'hooks/failed'(event: HookName, error: unknown): void;
  }
}

export const name = 'hooks';
export const inject: readonly string[] = ['taskRuntime', 'a2a', 'strings', 'redactor'];

const jsonValue: z.ZodType<Json> = z.json();
const toolInput = z.object({
  call: z.object({ id: z.string(), name: z.string(), args: jsonValue }),
});
const toolOutput = z.object({ ok: z.boolean() });
const llmOutput = z.object({ toolCalls: z.array(z.object({ name: z.string() })) });
const transitionInput = z.object({ reason: z.string() });
const transitionOutput = z.object({ state: z.string(), subState: z.string().nullable() });
const agentArgs = z.object({ agent: z.string() });
const participantArgs = z.object({ to: z.string() });
/** The tools that reach a participant, who may be an agent, named by `to`. */
const PARTICIPANT_TOOLS: ReadonlySet<string> = new Set([
  MESSAGE_PARTICIPANT,
  CREATE_TASK_FOR_PARTICIPANT,
]);

/** The agent a call would reach, or null when the tool is not one that reaches an agent. */
function agentOf(call: ToolCall): string | null {
  if (call.name === INVOKE_AGENT) {
    const args = agentArgs.safeParse(call.args);
    return args.success ? args.data.agent : '';
  }
  if (PARTICIPANT_TOOLS.has(call.name)) {
    const args = participantArgs.safeParse(call.args);
    return args.success ? args.data.to : '';
  }
  return null;
}

/** Tells the hooks what a finished step did. */
async function after(hooks: Hooks, call: StepCall, result: unknown): Promise<void> {
  const about = { taskId: call.taskId, key: call.key };
  if (call.name === 'llm.invoke') {
    const output = llmOutput.safeParse(result);
    const toolCalls = output.success ? output.data.toolCalls.map((asked) => asked.name) : [];
    await hooks.dispatch('llm.after', { ...about, toolCalls });
  } else if (call.name === 'tool.invoke') {
    const input = toolInput.safeParse(call.input);
    const output = toolOutput.safeParse(result);
    if (input.success && output.success) {
      const { id, name: tool, args } = input.data.call;
      await hooks.dispatch('tool.after', { ...about, tool, callId: id, args, ok: output.data.ok });
    }
  } else if (call.name === 'task.transition') {
    const input = transitionInput.safeParse(call.input);
    const output = transitionOutput.safeParse(result);
    if (input.success && output.success) {
      await hooks.dispatch('task.transition', { ...about, ...input.data, ...output.data });
    }
  }
}

function middleware(hooks: Hooks): StepMiddleware {
  return async <T>(call: StepCall, next: () => Promise<T>): Promise<T> => {
    if (call.name === 'llm.invoke') {
      await hooks.dispatch('llm.before', { taskId: call.taskId, key: call.key });
    }
    const result = await next();
    await after(hooks, call, result);
    return result;
  };
}

/** Asks `tool.before`, and `agent.before` when the call reaches an agent, whether it may run. */
function guard(ctx: Context, hooks: Hooks): ToolGuard {
  return async (call: ToolCall, about): Promise<ToolError | null> => {
    const facts = { taskId: about.taskId, key: about.key, callId: call.id, args: call.args };
    let verdict = await hooks.dispatch('tool.before', { ...facts, tool: call.name });
    let point: HookName = 'tool.before';
    const agent = agentOf(call);
    if (verdict.decision === 'allow' && agent !== null) {
      verdict = await hooks.dispatch('agent.before', { ...facts, agent });
      point = 'agent.before';
    }
    if (verdict.decision === 'allow') {
      return null;
    }
    // The step that stores the result redacts it too; this keeps the event clean as well.
    const reason = ctx.redactor.redactString(verdict.reason);
    ctx.emit('hooks/denied', point, call.name, reason);
    return {
      code: 'denied',
      message: ctx.strings.t('hooks.tool.denied', { name: call.name, reason }),
    };
  };
}

/** Asks `message.received` whether a message may enter the inbox. */
function interceptor(
  ctx: Context,
  hooks: Hooks,
): (request: RequestContext) => Promise<Message | null> {
  return async (request: RequestContext): Promise<Message | null> => {
    const taskId = request.task === undefined ? null : request.taskId;
    const verdict = await hooks.dispatch('message.received', {
      taskId,
      contextId: request.contextId,
      text: messageText(request.userMessage),
    });
    if (verdict.decision === 'allow') {
      return null;
    }
    const reason = ctx.redactor.redactString(verdict.reason);
    ctx.emit('hooks/denied', 'message.received', taskId ?? request.contextId, reason);
    ctx.emit('inbox/discarded', taskId ?? '', reason);
    return agentMessage({
      messageId: `hook-${request.userMessage.messageId}`,
      taskId: taskId ?? '',
      contextId: request.contextId,
      parts: [{ type: 'text', text: ctx.strings.t('hooks.message.denied', { reason }) }],
    });
  };
}

/** Starts the hooks plugin. */
export function apply(ctx: Context): void {
  const hooks = new Hooks((event: HookName, error: unknown) => {
    ctx.emit('hooks/failed', event, error);
    const reason = ctx.redactor.redactString(
      error instanceof Error ? error.message : String(error),
    );
    ctx
      .get('log')
      ?.record('harness.event', { event: 'hooks/failed', hook: event, error: reason }, 'error');
  });
  ctx.on('hooks/denied', (event: HookName, subject: string, reason: string) => {
    ctx
      .get('log')
      ?.record('harness.event', { event: 'hooks/denied', hook: event, subject, reason }, 'warn');
  });
  ctx.provide('hooks', hooks);
  ctx.effect(() => ctx.taskRuntime.addStepMiddleware(middleware(hooks)));
  ctx.effect(() => ctx.taskRuntime.addToolGuard(guard(ctx, hooks)));
  ctx.effect(() => ctx.a2a.addInterceptor(interceptor(ctx, hooks)));
}
