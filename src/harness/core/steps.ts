/**
 * The implementation of every step of the core loop — the code that has effects. Under
 * Temporal each of these is an activity.
 *
 * Every handler writes under the step key it is given and replaces what that key wrote
 * before, so performing a step twice leaves the stores as performing it once.
 */
import type { Redactor } from '../../kernel/redactor.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import type { LLM, LlmEvent } from '../models/llm/types.ts';
import { executeToolCall } from '../tools/execute.ts';
import type { SkillsSection } from './context/builder.ts';
import { PLAN_SNAPSHOT, buildContext, estimateTokens } from './context/builder.ts';
import type { StepContext, StepHandlers } from './direct-runner.ts';
import type { Persistence } from './persistence.ts';
import { formatPlan } from './plan.ts';
import type { StepInput, StepOutput, TransitionRequest } from './step-runner.ts';
import type { StreamSink, TaskPort, TaskSnapshot } from './task-port.ts';
import { nextStatus } from './transitions.ts';
import type {
  ContentPart,
  ConversationEvent,
  ConversationEventBody,
  InboxItem,
  ToolCall,
  ToolResult,
} from './types.ts';

/** Replaces older conversation with a summary. Provided by the compaction module. */
export type Compactor = (ctx: StepContext) => Promise<StepOutput<'context.compact'>>;

/** What the step implementations work with. */
export interface StepDeps {
  readonly registry: EntityRegistry;
  readonly persistence: Persistence;
  readonly tasks: TaskPort;
  readonly sink: StreamSink;
  readonly redactor: Redactor;
  /** The LLM entity id used when a task has not chosen one. */
  readonly defaultLlm: string;
  /** Fraction of the model's context window at which compaction starts. */
  readonly compactionThreshold: number;
  /** How long one tool call may take. */
  readonly toolTimeoutMs: number;
  readonly skills?: SkillsSection | undefined;
  readonly compact?: Compactor | undefined;
}

function toEvent(item: InboxItem, asResultOf: string | undefined): ConversationEventBody | null {
  const { payload } = item;
  if (payload.kind === 'event') {
    return { type: 'event', sourceId: item.id, event: payload.event };
  }
  if (payload.kind !== 'message') {
    return null;
  }
  if (asResultOf !== undefined) {
    const result: ToolResult = { ok: true, content: payload.parts };
    return { type: 'tool-result', callId: asResultOf, result };
  }
  return { type: 'message', role: 'user', parts: payload.parts, sourceId: item.id };
}

function resolveLlm(deps: StepDeps, task: TaskSnapshot): LLM {
  return deps.registry.resolve({ kind: 'llm', id: task.llm ?? deps.defaultLlm, version: null });
}

async function request(
  deps: StepDeps,
  taskId: string,
): Promise<{ task: TaskSnapshot; llm: LLM; request: ReturnType<typeof buildContext> }> {
  const [task, events, snapshot] = await Promise.all([
    deps.tasks.load(taskId),
    deps.persistence.conversation.read(taskId),
    deps.persistence.state.get(taskId, PLAN_SNAPSHOT),
  ]);
  const built = buildContext({
    registry: deps.registry,
    task,
    planSnapshot: typeof snapshot === 'string' ? snapshot : '',
    events,
    skills: deps.skills,
  });
  return { task, llm: resolveLlm(deps, task), request: built };
}

/** Collects what one model call produced, forwarding text to the stream as it arrives. */
async function consume(
  deps: StepDeps,
  ctx: StepContext,
  stream: AsyncIterable<LlmEvent>,
): Promise<{ events: ConversationEventBody[]; output: StepOutput<'llm.invoke'> }> {
  const events: ConversationEventBody[] = [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for await (const event of stream) {
    if (event.type === 'text.delta') {
      text += event.text;
      deps.sink.delta(ctx.taskId, ctx.key, event.text);
    } else if (event.type === 'tool-call') {
      toolCalls.push(event.call);
      events.push({ type: 'tool-call', call: event.call, opaque: event.opaque });
    } else if (event.type === 'reasoning') {
      events.push({ type: 'reasoning', opaque: event.opaque });
    } else {
      ({ usage } = event);
    }
  }
  if (text.length > 0) {
    const parts: ContentPart[] = [{ type: 'text', text }];
    events.unshift({ type: 'message', role: 'agent', parts, sourceId: ctx.key });
  }
  return { events, output: { toolCalls, usage } };
}

function lastAgentMessage(events: readonly ConversationEvent[]): readonly ContentPart[] {
  const last = events.findLast(
    (event: ConversationEvent) => event.type === 'message' && event.role === 'agent',
  );
  return last?.type === 'message' ? last.parts : [];
}

async function statusMessage(
  deps: StepDeps,
  taskId: string,
  input: TransitionRequest,
): Promise<readonly ContentPart[]> {
  if (input.reason === 'turn-complete') {
    return lastAgentMessage(await deps.persistence.conversation.read(taskId));
  }
  if (input.reason === 'ask-user') {
    return [{ type: 'text', text: input.question }];
  }
  if (input.reason === 'error') {
    return [{ type: 'text', text: deps.redactor.redactString(input.cause) }];
  }
  return [];
}

function redactResult(deps: StepDeps, result: ToolResult): ToolResult {
  if (!result.ok) {
    const message = deps.redactor.redactString(result.error.message);
    return { ok: false, error: { code: result.error.code, message } };
  }
  const content = result.content.map((part: ContentPart): ContentPart =>
    part.type === 'text' ? { type: 'text', text: deps.redactor.redactString(part.text) } : part,
  );
  return result.structured === undefined
    ? { ok: true, content }
    : { ok: true, content, structured: deps.redactor.redact(result.structured) };
}

/**
 * Stops a step that was abandoned — its turn interrupted or its task cancelled — before
 * it writes. What an abandoned step produced must not appear in the conversation.
 */
function assertCurrent(ctx: StepContext): void {
  if (ctx.signal.aborted) {
    throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('step abandoned');
  }
}

/** Moves inbox items into the conversation, then marks them processed — in that order. */
async function acceptItems(
  deps: StepDeps,
  ctx: StepContext,
  input: StepInput<'conversation.accept'>,
): Promise<StepOutput<'conversation.accept'>> {
  const { conversation, inbox, state, plan } = deps.persistence;
  const items = await inbox.get(input.itemIds);
  const events = items
    .map((item: InboxItem) => toEvent(item, input.asResultOf))
    .filter((event: ConversationEventBody | null) => event !== null);
  await conversation.put(ctx.taskId, ctx.key, events);
  if (input.asResultOf === undefined) {
    // A turn starts here: capture the plan the model will be shown for the whole turn.
    const current = await plan.load(ctx.taskId);
    await state.set(ctx.taskId, ctx.key, PLAN_SNAPSHOT, current ? formatPlan(current) : '');
  }
  await inbox.markProcessed(input.itemIds);
  return { accepted: events.length };
}

/** Builds the step implementations over `deps`. */
export function createStepHandlers(deps: StepDeps): StepHandlers {
  const { conversation } = deps.persistence;
  return {
    'conversation.accept': (ctx, input) => acceptItems(deps, ctx, input),
    'context.build': async (ctx) => {
      const built = await request(deps, ctx.taskId);
      const estimatedTokens = estimateTokens(built.request);
      const budget = deps.compactionThreshold * built.llm.capabilities.contextWindow;
      return { estimatedTokens, compact: estimatedTokens > budget };
    },
    'context.compact': (ctx) =>
      deps.compact === undefined ? Promise.resolve({ before: 0, after: 0 }) : deps.compact(ctx),
    'llm.invoke': async (ctx) => {
      const built = await request(deps, ctx.taskId);
      deps.sink.reset(ctx.taskId, ctx.key);
      const result = await consume(deps, ctx, built.llm.stream(built.request, ctx.signal));
      assertCurrent(ctx);
      await conversation.put(ctx.taskId, ctx.key, result.events);
      const [first] = result.events;
      if (first?.type === 'message') {
        await deps.tasks.setReply(ctx.taskId, ctx.key, first.parts);
      }
      return result.output;
    },
    'tool.invoke': async (ctx, input) => {
      const raw = await executeToolCall(deps.registry, input.call, ctx, {
        timeoutMs: deps.toolTimeoutMs,
      });
      const result = redactResult(deps, raw);
      assertCurrent(ctx);
      await conversation.put(ctx.taskId, ctx.key, [
        { type: 'tool-result', callId: input.call.id, result },
      ]);
      return { ok: result.ok };
    },
    'task.transition': async (ctx, input) => {
      const task = await deps.tasks.load(ctx.taskId);
      const status = nextStatus(task.longRunning, input);
      await deps.tasks.setStatus(ctx.taskId, ctx.key, {
        ...status,
        message: await statusMessage(deps, ctx.taskId, input),
      });
      return status;
    },
  };
}
