/**
 * The implementation of every step of the core loop — the code that has effects. Under
 * Temporal each of these is an activity.
 *
 * Every handler writes under the step key it is given and replaces what that key wrote
 * before, so performing a step twice leaves the stores as performing it once.
 */
import type { Json } from '../../kernel/json.ts';
import type { Redactor } from '../../kernel/redactor.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import type { LLM, LlmEvent } from '../models/llm/types.ts';
import { NO_USAGE } from '../models/llm/types.ts';
import { t } from '../../kernel/strings.ts';
import type { ToolGuard } from '../tools/execute.ts';
import { executeToolCall } from '../tools/execute.ts';
import { errorResult } from '../tools/types.ts';
import type { SkillsSection } from './context/builder.ts';
import { PLAN_SNAPSHOT, buildContext, estimateTokens } from './context/builder.ts';
import { assertCurrent } from './current-step.ts';
import type { StepContext, StepHandlers } from './direct-runner.ts';
import type { FilePart } from './modalities.ts';
import { prepareMedia } from './modalities.ts';
import type { Persistence } from './persistence.ts';
import { formatPlan } from './plan.ts';
import type { StepInput, StepOutput, TransitionRequest } from './step-runner.ts';
import type { StreamSink, TaskPort, TaskSnapshot } from './task-port.ts';
import { ReplyParts, readThrough } from './reply.ts';
import { nextStatus } from './transitions.ts';
import type { SpeechDeps } from './voice.ts';
import { openSpokenReply } from './voice.ts';
import type {
  ContentPart,
  ConversationEvent,
  ConversationEventBody,
  InboxItem,
  ToolCall,
  ToolResult,
} from './types.ts';

/** A piece of a model's reply after a turn extension has read it. */
export type ReplyPiece =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'data'; readonly mediaType: string; readonly data: Json };

/** Reads a reply as it streams and turns marked-up spans into structured parts. */
export interface ReplyStream {
  /** Takes the next chunk of text and returns the pieces that are complete so far. */
  feed(chunk: string): readonly ReplyPiece[];
  /** Called after the last chunk; returns whatever was held back. */
  close(): readonly ReplyPiece[];
}

/**
 * What a plugin adds to one turn of one task — for example, teaching the model to emit
 * A2UI when the client said it can render it, and turning what the model wrote into
 * validated UI messages.
 */
export interface TurnExtension {
  /** Added to the context as its own system message. */
  readonly promptSection: string;
  /** Opens a reader for the next reply. */
  openReply(): ReplyStream;
}

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
  /** The reasoning effort used when a task has not chosen one and the model offers it. */
  readonly defaultEffort?: string | undefined;
  /** Fraction of the model's context window at which compaction starts. */
  readonly compactionThreshold: number;
  /** How long one tool call may take. */
  readonly toolTimeoutMs: number;
  readonly skills?: SkillsSection | undefined;
  /** Asked before every tool call; it may refuse the call. */
  readonly toolGuard?: ToolGuard | undefined;
  /** What plugins add to a turn: a prompt section and a transformation of the reply. */
  readonly turnExtensions?: ((task: TaskSnapshot) => readonly TurnExtension[]) | undefined;
  readonly compact?: Compactor | undefined;
  /** The speech models in use: one to transcribe audio turns, one to speak answers. */
  readonly speech?: SpeechDeps | undefined;
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

/** The next model call of a task, or what to answer in its place. */
interface Built {
  readonly task: TaskSnapshot;
  readonly llm: LLM;
  readonly request: ReturnType<typeof buildContext>;
  readonly extensions: readonly TurnExtension[];
  /** Set when the turn carries content the model cannot take: the answer to give instead. */
  readonly refusal: string | null;
}

async function request(deps: StepDeps, ctx: StepContext): Promise<Built> {
  const { taskId } = ctx;
  const [task, stored, snapshot] = await Promise.all([
    deps.tasks.load(taskId),
    deps.persistence.conversation.read(taskId),
    deps.persistence.state.get(taskId, PLAN_SNAPSHOT),
  ]);
  const llm = resolveLlm(deps, task);
  const { state } = deps.persistence;
  const stt = (): ReturnType<SpeechDeps['stt']> => deps.speech?.stt() ?? null;
  const media = { registry: deps.registry, state, stt };
  const { events, refusal } = await prepareMedia(media, ctx, llm, stored);
  const extensions = deps.turnExtensions?.(task) ?? [];
  const built = buildContext({
    registry: deps.registry,
    task,
    planSnapshot: typeof snapshot === 'string' ? snapshot : '',
    events,
    skills: deps.skills,
    extraSections: extensions.map((extension: TurnExtension) => extension.promptSection),
  });
  const fallback = deps.defaultEffort;
  const effort =
    built.effort ??
    (fallback !== undefined && llm.capabilities.efforts.includes(fallback) ? fallback : undefined);
  return { task, llm, request: { ...built, effort }, extensions, refusal };
}

/** Collects what one model call produced, forwarding text to the stream as it arrives. */
async function consume(
  deps: StepDeps,
  ctx: StepContext,
  stream: AsyncIterable<LlmEvent>,
  built: Built,
): Promise<{ events: ConversationEventBody[]; output: StepOutput<'llm.invoke'> }> {
  const events: ConversationEventBody[] = [];
  const toolCalls: ToolCall[] = [];
  const readers = built.extensions.map((extension: TurnExtension) => extension.openReply());
  const spoken = openSpokenReply(deps.speech, deps.sink, ctx, built.task);
  const reply = new ReplyParts((text: string) => {
    deps.sink.delta(ctx.taskId, ctx.key, text);
    spoken?.say(text);
  });
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  try {
    for await (const event of stream) {
      if (event.type === 'text.delta') {
        reply.add(readThrough(readers, event.text));
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call);
        events.push({ type: 'tool-call', call: event.call, opaque: event.opaque });
      } else if (event.type === 'reasoning') {
        events.push({ type: 'reasoning', opaque: event.opaque });
      } else {
        ({ usage } = event);
      }
    }
  } catch (error) {
    // The answer is lost; what was being said of it must not go on.
    spoken?.abandon();
    throw error;
  }
  reply.add(readThrough(readers, null));
  await spoken?.finish();
  if (reply.parts.length > 0) {
    events.unshift({ type: 'message', role: 'agent', parts: reply.parts, sourceId: ctx.key });
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

/**
 * A part with every registered secret replaced in its text, data, or a file's name, media
 * type and URL. File bytes are kept.
 */
function redactPart(deps: StepDeps, part: ContentPart): ContentPart {
  const clean = (value: string): string => deps.redactor.redactString(value);
  if (part.type === 'text') {
    return { type: 'text', text: clean(part.text) };
  }
  if (part.type === 'data') {
    return {
      type: 'data',
      mediaType: clean(part.mediaType),
      data: deps.redactor.redact(part.data),
    };
  }
  const source: FilePart['source'] =
    part.source.kind === 'url' ? { kind: 'url', url: clean(part.source.url) } : part.source;
  const file: FilePart = { type: 'file', mediaType: clean(part.mediaType), source };
  return part.name === undefined ? file : { ...file, name: clean(part.name) };
}

function redactResult(deps: StepDeps, result: ToolResult): ToolResult {
  if (!result.ok) {
    const message = deps.redactor.redactString(result.error.message);
    return { ok: false, error: { code: result.error.code, message } };
  }
  // Artifacts are left out: they are not shown to the model nor kept in the conversation.
  const content = result.content.map((part: ContentPart) => redactPart(deps, part));
  return result.structured === undefined
    ? { ok: true, content }
    : { ok: true, content, structured: deps.redactor.redact(result.structured) };
}

/** Answers the turn with `text` instead of calling the model. */
async function refuse(
  deps: StepDeps,
  ctx: StepContext,
  text: string,
): Promise<StepOutput<'llm.invoke'>> {
  const parts: ContentPart[] = [{ type: 'text', text }];
  const message = { type: 'message', role: 'agent', parts, sourceId: ctx.key } as const;
  await deps.persistence.conversation.put(ctx.taskId, ctx.key, [message]);
  await deps.tasks.setReply(ctx.taskId, ctx.key, parts);
  return { toolCalls: [], usage: NO_USAGE };
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

/** Runs one tool call, tells the interfaces about it, and stores its result. */
async function invokeTool(
  deps: StepDeps,
  ctx: StepContext,
  input: StepInput<'tool.invoke'>,
): Promise<StepOutput<'tool.invoke'>> {
  const { call } = input;
  const about = { kind: 'tool', id: call.id, name: call.name } as const;
  const startedAt = Date.now();
  deps.sink.activity(ctx.taskId, { ...about, phase: 'started' });
  const raw = ctx.outcomeUnknown
    ? errorResult('unknown-outcome', t('tool.error.unknown-outcome', { name: call.name }))
    : await executeToolCall(deps.registry, call, ctx, {
        timeoutMs: deps.toolTimeoutMs,
        guard: deps.toolGuard,
      });
  const result = redactResult(deps, raw);
  await assertCurrent(deps.tasks, deps.persistence.conversation, ctx);
  if (raw.ok && raw.artifacts !== undefined && raw.artifacts.length > 0) {
    // What a tool made for the person is an artifact of the task, not conversation.
    const artifacts = raw.artifacts.map((part: ContentPart) => redactPart(deps, part));
    await deps.tasks.addArtifact(ctx.taskId, ctx.key, artifacts);
  }
  await deps.persistence.conversation.put(ctx.taskId, ctx.key, [
    { type: 'tool-result', callId: call.id, result },
  ]);
  const durationMs = Date.now() - startedAt;
  deps.sink.activity(ctx.taskId, { ...about, phase: 'finished', ok: result.ok, durationMs });
  return { ok: result.ok };
}

/** Builds the step implementations over `deps`. */
export function createStepHandlers(deps: StepDeps): StepHandlers {
  const { conversation } = deps.persistence;
  return {
    'conversation.accept': (ctx, input) => acceptItems(deps, ctx, input),
    'context.build': async (ctx) => {
      const built = await request(deps, ctx);
      const estimatedTokens = built.refusal === null ? estimateTokens(built.request) : 0;
      const budget = deps.compactionThreshold * built.llm.capabilities.contextWindow;
      return { estimatedTokens, compact: estimatedTokens > budget };
    },
    'context.compact': (ctx) =>
      deps.compact === undefined ? Promise.resolve({ before: 0, after: 0 }) : deps.compact(ctx),
    'llm.invoke': async (ctx) => {
      const built = await request(deps, ctx);
      deps.sink.reset(ctx.taskId, ctx.key);
      if (built.refusal !== null) {
        return refuse(deps, ctx, built.refusal);
      }
      const stream = built.llm.stream(built.request, ctx.signal);
      const result = await consume(deps, ctx, stream, built);
      await assertCurrent(deps.tasks, deps.persistence.conversation, ctx);
      await conversation.put(ctx.taskId, ctx.key, result.events);
      const [first] = result.events;
      if (first?.type === 'message') {
        await deps.tasks.setReply(ctx.taskId, ctx.key, first.parts);
      }
      return result.output;
    },
    'tool.invoke': (ctx, input) => invokeTool(deps, ctx, input),
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
