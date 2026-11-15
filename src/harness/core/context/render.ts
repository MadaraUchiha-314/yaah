/**
 * Turning a task's conversation into the messages a model reads. Pure: the same events
 * always produce the same messages, which is what keeps the provider's prompt cache warm.
 */
import type { LlmContent, LlmMessage } from '../../models/llm/types.ts';
import type { ConversationEvent, ToolResult } from '../types.ts';

/** The result shown for a tool call that was abandoned before it produced one. */
export const INTERRUPTED: ToolResult = {
  ok: false,
  error: { code: 'interrupted', message: 'The call was interrupted before it finished.' },
};

/** Text the context builder needs from the prompt entities. */
export interface RenderTexts {
  /** Introduces content produced by a tool or another agent. */
  readonly untrustedData: string;
  /** Wraps a compaction summary; receives the summary text. */
  readonly summary: (text: string) => string;
}

function within(seq: number, summary: ConversationEvent): boolean {
  return summary.type === 'summary' && seq >= summary.replaces.from && seq < summary.replaces.to;
}

/** A later summary that covers where an earlier one stood replaces it. */
function isSuperseded(
  summary: ConversationEvent,
  summaries: readonly ConversationEvent[],
): boolean {
  return summaries.some(
    (other: ConversationEvent) => other.seq > summary.seq && within(position(summary), other),
  );
}

function position(event: ConversationEvent): number {
  return event.type === 'summary' ? event.replaces.from : event.seq;
}

/**
 * The events a reader sees, in reading order: a summary stands where the span it
 * replaces began, and what it replaces — including an earlier summary — is left out.
 */
export function visibleEvents(events: readonly ConversationEvent[]): ConversationEvent[] {
  const summaries = events.filter((event: ConversationEvent) => event.type === 'summary');
  const live = summaries.filter((summary: ConversationEvent) => !isSuperseded(summary, summaries));
  return events
    .filter((event: ConversationEvent) =>
      event.type === 'summary'
        ? live.includes(event)
        : !live.some((summary: ConversationEvent) => within(event.seq, summary)),
    )
    .toSorted(
      (a: ConversationEvent, b: ConversationEvent) => position(a) - position(b) || a.seq - b.seq,
    );
}

function assistantContent(event: ConversationEvent): LlmContent[] {
  switch (event.type) {
    case 'message': {
      return [...event.parts];
    }
    case 'tool-call': {
      return [{ type: 'tool-call', call: event.call, opaque: event.opaque }];
    }
    case 'reasoning': {
      return [{ type: 'reasoning', opaque: event.opaque }];
    }
    default: {
      return [];
    }
  }
}

function isAssistant(event: ConversationEvent): boolean {
  return (
    event.type === 'tool-call' ||
    event.type === 'reasoning' ||
    (event.type === 'message' && event.role === 'agent')
  );
}

/** The `tool` message answering every call of an assistant message, in call order. */
function toolResults(
  content: readonly LlmContent[],
  results: ReadonlyMap<string, ToolResult>,
): LlmMessage | null {
  const answers: LlmContent[] = [];
  for (const block of content) {
    if (block.type === 'tool-call') {
      answers.push({
        type: 'tool-result',
        callId: block.call.id,
        result: results.get(block.call.id) ?? INTERRUPTED,
      });
    }
  }
  return answers.length === 0 ? null : { role: 'tool', content: answers };
}

function userMessage(event: ConversationEvent, texts: RenderTexts): LlmMessage | null {
  switch (event.type) {
    case 'message': {
      return { role: 'user', content: [...event.parts] };
    }
    case 'event': {
      const text = `${texts.untrustedData}\n\n${JSON.stringify(event.event)}`;
      return { role: 'user', content: [{ type: 'text', text }] };
    }
    case 'summary': {
      return { role: 'user', content: [{ type: 'text', text: texts.summary(event.text) }] };
    }
    default: {
      return null;
    }
  }
}

/**
 * Renders a conversation as model messages.
 *
 * - Everything one model call produced becomes one assistant message.
 * - Its tool results follow in one `tool` message, in the order the calls were issued —
 *   whatever order they finished in. A call with no result is shown as interrupted.
 * - Events hidden by a compaction summary are left out; the summary stands in their place.
 */
export function renderConversation(
  events: readonly ConversationEvent[],
  texts: RenderTexts,
): LlmMessage[] {
  const results = new Map<string, ToolResult>();
  for (const event of events) {
    if (event.type === 'tool-result') {
      results.set(event.callId, event.result);
    }
  }
  const messages: LlmMessage[] = [];
  let open: { key: string; content: LlmContent[] } | null = null;
  const close = (): void => {
    if (open !== null) {
      messages.push({ role: 'assistant', content: open.content });
      const answers = toolResults(open.content, results);
      if (answers !== null) {
        messages.push(answers);
      }
      open = null;
    }
  };
  for (const event of visibleEvents(events)) {
    if (isAssistant(event)) {
      if (open !== null && open.key !== event.key) {
        close();
      }
      open ??= { key: event.key, content: [] };
      open.content.push(...assistantContent(event));
    } else if (event.type !== 'tool-result') {
      close();
      const message = userMessage(event, texts);
      if (message !== null) {
        messages.push(message);
      }
    }
  }
  close();
  return messages;
}
