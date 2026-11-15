/**
 * Compaction: replacing the older part of a conversation with a summary before the
 * context outgrows the model's window.
 *
 * What is never compacted: the system prompt, the task and the plan (they are not part
 * of the conversation at all), a tool call of the newest model turn that has no result
 * yet, and a pinned message.
 * A model turn is never split from its tool results.
 */
import type { EntityRegistry } from '../../../kernel/registry.ts';
import type { LLM } from '../../models/llm/types.ts';
import { renderPrompt } from '../../system-prompt/prompt.ts';
import type { StepContext } from '../direct-runner.ts';
import type { Persistence } from '../persistence.ts';
import { formatPlan } from '../plan.ts';
import type { Compactor } from '../steps.ts';
import type { TaskPort } from '../task-port.ts';
import type { ConversationEvent, SeqRange } from '../types.ts';
import { PLAN_SNAPSHOT, estimateTokens } from './builder.ts';
import { visibleEvents } from './render.ts';

/** How a conversation is compacted. Replace it by providing the `compaction` service. */
export interface CompactionStrategy {
  /**
   * Chooses the span to replace with a summary, as a range of sequence numbers.
   *
   * MUST NOT include a pinned message or a tool call of the newest model turn without a
   * result, and MUST NOT end inside a model turn.
   *
   * @param keepTokens The most recent part of the conversation to leave untouched.
   * @returns null when nothing can be replaced.
   */
  select(events: readonly ConversationEvent[], keepTokens: number): SeqRange | null;
  /** Writes the summary of `span`. `instructions` is the compaction prompt. */
  summarize(
    span: readonly ConversationEvent[],
    llm: LLM,
    instructions: string,
    signal: AbortSignal,
  ): Promise<string>;
}

/** Where an event sits when the conversation is read: a summary stands for its span. */
function position(event: ConversationEvent): number {
  return event.type === 'summary' ? event.replaces.from : event.seq;
}

/** A turn starts at something the user or the outside world said. */
function startsTurn(event: ConversationEvent): boolean {
  return (
    event.type === 'summary' ||
    event.type === 'event' ||
    (event.type === 'message' && event.role === 'user')
  );
}

/** Whether the model wrote `event`: its reply, a tool call or its reasoning. */
function fromModel(event: ConversationEvent): boolean {
  return (
    event.type === 'tool-call' ||
    event.type === 'reasoning' ||
    (event.type === 'message' && event.role === 'agent')
  );
}

/**
 * The index of the first event that must not be compacted, or the list length.
 *
 * Only a call of the newest model turn can still be waiting for its result. A call of an
 * older turn without one was abandoned — an interrupt took its turn — and no result will
 * ever come; protecting it would stop compaction for the rest of the task.
 */
function firstProtected(events: readonly ConversationEvent[]): number {
  const answered = new Set(
    events.flatMap((event: ConversationEvent) =>
      event.type === 'tool-result' ? [event.callId] : [],
    ),
  );
  const newest = events.findLast((event: ConversationEvent) => fromModel(event))?.key;
  const index = events.findIndex(
    (event: ConversationEvent) =>
      (event.type === 'message' && event.pinned === true) ||
      (event.type === 'tool-call' && event.key === newest && !answered.has(event.call.id)),
  );
  return index === -1 ? events.length : index;
}

/** The index where the kept suffix starts when keeping about `keepTokens` from the end. */
function budgetCut(events: readonly ConversationEvent[], keepTokens: number): number {
  let kept = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    kept += estimateTokens(events[index]);
    if (kept > keepTokens) {
      return index + 1;
    }
  }
  return 0;
}

function describe(event: ConversationEvent): string {
  switch (event.type) {
    case 'message': {
      const text = event.parts
        .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
        .join('');
      return `${event.role}: ${text}`;
    }
    case 'tool-call': {
      return `tool call ${event.call.name}: ${JSON.stringify(event.call.args)}`;
    }
    case 'tool-result': {
      return `tool result: ${JSON.stringify(event.result)}`;
    }
    case 'event': {
      return `event: ${JSON.stringify(event.event)}`;
    }
    case 'summary': {
      return `earlier summary: ${event.text}`;
    }
    default: {
      return '';
    }
  }
}

/** The strategy yaah ships: summarise everything but the most recent turns. */
export const defaultCompactionStrategy: CompactionStrategy = {
  select(events: readonly ConversationEvent[], keepTokens: number): SeqRange | null {
    const ordered = visibleEvents(events);
    const isTurnStart = (index: number): boolean => {
      const event = ordered[index];
      return event !== undefined && startsTurn(event);
    };
    // Move the cut forward to the start of a turn, so no turn is split. If that runs off
    // the end, the last turn is larger than the budget: keep all of it instead.
    let cut = budgetCut(ordered, keepTokens);
    while (cut < ordered.length && !isTurnStart(cut)) {
      cut += 1;
    }
    // Then back to the start of the turn holding the first protected event.
    let limit = Math.min(cut, firstProtected(ordered), ordered.length - 1);
    while (limit > 0 && !isTurnStart(limit)) {
      limit -= 1;
    }
    const first = ordered[0];
    const boundary = ordered[limit];
    if (first === undefined || boundary === undefined || limit < 2) {
      return null;
    }
    return { from: position(first), to: position(boundary) };
  },

  async summarize(
    span: readonly ConversationEvent[],
    llm: LLM,
    instructions: string,
    signal: AbortSignal,
  ): Promise<string> {
    const transcript = span
      .map((event: ConversationEvent) => describe(event))
      .filter((line: string) => line.length > 0)
      .join('\n');
    let text = '';
    const request = {
      messages: [
        { role: 'system' as const, content: [{ type: 'text' as const, text: instructions }] },
        { role: 'user' as const, content: [{ type: 'text' as const, text: transcript }] },
      ],
      tools: [],
    };
    for await (const event of llm.stream(request, signal)) {
      if (event.type === 'text.delta') {
        text += event.text;
      }
    }
    return text.trim();
  },
};

/** What {@link createCompactor} works with. */
export interface CompactorDeps {
  readonly registry: EntityRegistry;
  readonly persistence: Persistence;
  readonly tasks: TaskPort;
  readonly defaultLlm: string;
  /** Fraction of the model's context window left untouched at the recent end. */
  readonly keepRecentFraction: number;
  readonly strategy?: CompactionStrategy | undefined;
  /** Told the conversation's token estimate before and after each compaction. */
  readonly onCompacted?: ((taskId: string, before: number, after: number) => void) | undefined;
}

/**
 * Builds the `context.compact` step: choose a span, summarise it with the task's model,
 * and store the summary under the step's key so that a retry replaces it.
 */
export function createCompactor(deps: CompactorDeps): Compactor {
  const strategy = deps.strategy ?? defaultCompactionStrategy;
  return async (ctx: StepContext) => {
    const { conversation, plan, state } = deps.persistence;
    const [task, events] = await Promise.all([
      deps.tasks.load(ctx.taskId),
      conversation.read(ctx.taskId),
    ]);
    const llm = deps.registry.resolve({
      kind: 'llm',
      id: task.llm ?? deps.defaultLlm,
      version: null,
    });
    const before = estimateTokens(visibleEvents(events));
    const range = strategy.select(events, deps.keepRecentFraction * llm.capabilities.contextWindow);
    if (range === null) {
      return { before, after: before };
    }
    const span = visibleEvents(events).filter((event: ConversationEvent) => {
      const at = position(event);
      return at >= range.from && at < range.to;
    });
    const instructions = renderPrompt(deps.registry, 'compaction', {});
    const text = await strategy.summarize(span, llm, instructions, ctx.signal);
    await conversation.put(ctx.taskId, ctx.key, [{ type: 'summary', replaces: range, text }]);
    // Compaction is one of the two moments the plan shown to the model is refreshed.
    const current = await plan.load(ctx.taskId);
    await state.set(ctx.taskId, ctx.key, PLAN_SNAPSHOT, current ? formatPlan(current) : '');
    const after = estimateTokens(visibleEvents(await conversation.read(ctx.taskId)));
    deps.onCompacted?.(ctx.taskId, before, after);
    return { before, after };
  };
}
