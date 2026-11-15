/**
 * The tool interface. A tool is anything the model can ask the harness to run: an MCP
 * tool, a sub-agent, or one of yaah's own state tools. All are `tool` entities.
 */
import type { Entity } from '../../kernel/entity.ts';
import { LOCAL } from '../../kernel/entity.ts';
import type { Json, JsonObject } from '../../kernel/json.ts';
import type { StepKey, TaskId, ToolResult } from '../core/types.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    tool: Tool;
  }
}

/** What a tool is told about the call it is serving. */
export interface ToolCallContext {
  readonly taskId: TaskId;
  /** The model's id for this call. */
  readonly callId: string;
  /** The step this call runs as; a tool that writes state keys its writes with it. */
  readonly key: StepKey;
  /** Aborted when the task is cancelled or the turn is interrupted. */
  readonly signal: AbortSignal;
}

/** Something the model can run. */
export interface Tool extends Entity<'tool'> {
  /**
   * JSON Schema of the arguments object. Required: arguments are validated against it
   * before `invoke` is called, and a tool without one cannot be registered.
   */
  readonly inputSchema: JsonObject;
  /**
   * Whether calling it again after an unknown outcome is safe (read-only or idempotent).
   * A tool that is not is attempted at most once.
   */
  readonly retrySafe: boolean;
  /**
   * The longest description passed to a model. Absent means the context builder's
   * `MAX_DESCRIPTION_LENGTH`. A tool that lists third-party texts, each capped on its own,
   * raises it in proportion to how many it lists.
   */
  readonly maxDescriptionLength?: number | undefined;
  /**
   * Runs the tool. A failure the model should know about is returned as
   * `{ ok: false, error }`; a thrown error is turned into one by the caller.
   */
  invoke(args: Json, ctx: ToolCallContext): Promise<ToolResult>;
}

/** What {@link defineTool} needs. */
export interface ToolDefinition {
  /** Also the name the model calls it by: letters, digits, `_` and `-`, at most 64. */
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly retrySafe?: boolean;
  readonly invoke: Tool['invoke'];
}

/** Builds a local, unversioned tool entity. */
export function defineTool(definition: ToolDefinition): Tool {
  return {
    ref: { kind: 'tool', id: definition.id, version: null },
    description: definition.description,
    locality: LOCAL,
    inputSchema: definition.inputSchema,
    retrySafe: definition.retrySafe ?? false,
    invoke: definition.invoke,
  };
}

/** A successful result holding one text part. */
export function textResult(text: string): ToolResult {
  return { ok: true, content: [{ type: 'text', text }] };
}

/** A failed result. */
export function errorResult(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}
