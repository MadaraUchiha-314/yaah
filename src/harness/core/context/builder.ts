/**
 * The context window manager: assembles what is sent to the model on every call, from
 * templated positions in a fixed order —
 *
 *   1 system prompt · 2 skills · 3 tools and sub-agents · 4 task · 5 plan · 6 conversation
 *
 * — and keeps each position byte-identical while what it shows has not changed, so the
 * provider's prompt cache is hit.
 */
import type { JsonObject } from '../../../kernel/json.ts';
import type { EntityRegistry } from '../../../kernel/registry.ts';
import type { LlmMessage, LlmRequest, ToolDeclaration } from '../../models/llm/types.ts';
import { renderPrompt } from '../../system-prompt/prompt.ts';
import type { Tool } from '../../tools/types.ts';
import type { TaskSnapshot } from '../task-port.ts';
import type { ConversationEvent, Participant, TaskModel } from '../types.ts';
import { renderConversation } from './render.ts';

/** The longest third-party description passed to a model. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Name under which the plan snapshot of the current turn is kept in the task's state. */
export const PLAN_SNAPSHOT = 'yaah.plan-snapshot';

/** Extra text for position 2 (skills). Registered by the skills plugin; empty without it. */
export type SkillsSection = () => string;

/** What {@link buildContext} reads. */
export interface ContextInputs {
  readonly registry: EntityRegistry;
  readonly task: TaskSnapshot;
  /** The plan text captured at the start of the turn, or empty when there is no plan. */
  readonly planSnapshot: string;
  readonly events: readonly ConversationEvent[];
  readonly skills?: SkillsSection | undefined;
  /** Sections plugins add for this turn; each becomes a system message after the head. */
  readonly extraSections?: readonly string[] | undefined;
  /** Tool ids the task may use. Absent means every registered tool. */
  readonly allowedTools?: ReadonlySet<string> | undefined;
}

/**
 * Makes third-party text safe to show a model as a description: control characters are
 * removed and the text is capped. It is still data — the system prompt says so.
 */
export function sanitizeDescription(text: string): string {
  // oxlint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = text.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '');
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? cleaned.slice(0, MAX_DESCRIPTION_LENGTH)
    : cleaned;
}

function declare(tool: Tool): ToolDeclaration {
  const schema: JsonObject = tool.inputSchema;
  return {
    name: tool.ref.id,
    description: sanitizeDescription(tool.description),
    inputSchema: schema,
  };
}

/** The longest short caller-supplied value — a name, an id, a criterion — shown as data. */
const MAX_LABEL_LENGTH = 200;

/**
 * Shows a value a caller supplied as data: on one line, capped, and quoted as a JSON
 * string, so that no newline, heading or closing quote in it can pass for the section's
 * own text.
 */
function quoted(text: string, max: number = MAX_DESCRIPTION_LENGTH): string {
  const line = sanitizeDescription(text).replaceAll(/\s+/gu, ' ').trim();
  return JSON.stringify(line.length > max ? line.slice(0, max) : line);
}

/** One line per participant, led by the id the model names them by. */
function participantLines(participants: readonly Participant[]): string {
  return participants
    .map((participant: Participant) => {
      const { displayName, id, kind, role } = participant;
      const called = displayName === undefined ? '' : ` — ${quoted(displayName, MAX_LABEL_LENGTH)}`;
      return `- ${quoted(id, MAX_LABEL_LENGTH)}${called} (${kind}): ${role}`;
    })
    .join('\n');
}

function taskSection(registry: EntityRegistry, model: TaskModel): string {
  const task = renderPrompt(registry, 'task', {
    name: quoted(model.name, MAX_LABEL_LENGTH),
    goal: quoted(model.goal),
    description: quoted(model.description),
    acceptanceCriteria: model.acceptanceCriteria
      .map((criterion: string) => quoted(criterion, MAX_LABEL_LENGTH))
      .join('; '),
  });
  const roles = renderPrompt(registry, 'roles', {
    participants: participantLines(model.participants),
  });
  return `${task}\n\n${roles}`;
}

function system(text: string, cacheBoundary = false): LlmMessage {
  return { role: 'system', content: [{ type: 'text', text }], cacheBoundary };
}

/** Marks the last message before the newest as stable, so the conversation is cached too. */
function withMovingBoundary(messages: readonly LlmMessage[]): LlmMessage[] {
  const index = messages.length - 2;
  return messages.map((message: LlmMessage, at: number) =>
    at === index ? { ...message, cacheBoundary: true } : message,
  );
}

/**
 * Builds the request for the next model call.
 *
 * Tools are declared sorted by id; no timestamp or generated id appears before the
 * conversation. The plan shown is the snapshot taken at the start of the turn: a change
 * made during the turn reaches the model as a tool result, so that position 5 — and the
 * cached conversation behind it — is not rewritten on every step.
 */
export function buildContext(inputs: ContextInputs): LlmRequest {
  const { registry, task } = inputs;
  const skills = inputs.skills?.() ?? '';
  const head = [renderPrompt(registry, 'system', {}), skills]
    .filter((text: string) => text.length > 0)
    .join('\n\n');
  const messages: LlmMessage[] = [
    system(head, true),
    ...(inputs.extraSections ?? [])
      .filter((text: string) => text !== '')
      .map((text: string) => system(text, true)),
    system(taskSection(registry, task.model)),
  ];
  if (inputs.planSnapshot.length > 0) {
    messages.push(system(renderPrompt(registry, 'plan', { steps: inputs.planSnapshot }), true));
  }
  const conversation = renderConversation(inputs.events, {
    untrustedData: renderPrompt(registry, 'untrusted-data', {}),
    summary: (text: string) => renderPrompt(registry, 'summary', { summary: text }),
  });
  const tools = registry
    .list('tool')
    .filter((tool: Tool) => inputs.allowedTools?.has(tool.ref.id) ?? true)
    .map((tool: Tool) => declare(tool));
  return {
    messages: [...messages, ...withMovingBoundary(conversation)],
    tools,
    effort: task.effort ?? undefined,
    cacheKey: task.taskId,
  };
}

/** What an inline file is counted as, in characters: about a thousand tokens. */
const FILE_ESTIMATE = 'x'.repeat(4096);

/** Counts an inline file as a fixed size: its base64 length says nothing about its tokens. */
function withoutFileData(_key: string, value: unknown): unknown {
  const inline =
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'base64' &&
    'data' in value;
  return inline ? { kind: 'base64', data: FILE_ESTIMATE } : value;
}

/** A rough token count for a request: four characters per token. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value, withoutFileData).length / 4);
}
