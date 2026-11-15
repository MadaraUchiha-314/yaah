/**
 * Running a tool call the way the core loop needs it run: every refusal and every
 * failure comes back as a result for the model, never as an exception.
 */
import { Validator } from '@cfworker/json-schema';

import type { Json, JsonObject } from '../../kernel/json.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import type { ToolCall, ToolError, ToolResult } from '../core/types.ts';
import type { Tool, ToolCallContext } from './types.ts';
import { errorResult } from './types.ts';

/** Limits applied to one call. */
export interface ExecuteOptions {
  /** Tool ids the task may use. Absent means every registered tool. */
  readonly allowed?: ReadonlySet<string>;
  /** How long the tool may take. Absent means no limit beyond the caller's signal. */
  readonly timeoutMs?: number;
  /** Asked after the arguments passed their schema; an error it returns is the result. */
  readonly guard?: ToolGuard | undefined;
}

/**
 * A check made before a tool runs — how a hook refuses a call. Returns null to let the
 * call through, or the error the model is shown instead of a result. One that throws
 * refuses the call.
 */
export type ToolGuard = (
  call: ToolCall,
  ctx: Omit<ToolCallContext, 'callId'>,
) => Promise<ToolError | null>;

/**
 * Checks arguments against the tool's JSON Schema.
 *
 * Uses a validator that does not generate code, so it also runs under a strict browser
 * content-security policy.
 *
 * @returns null when valid, otherwise an `invalid-arguments` error naming the first problem.
 */
export function validateToolArgs(tool: Tool, args: Json): ToolError | null {
  // A tool written without types may arrive with no schema at all: fail closed.
  const schema: unknown = tool.inputSchema;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return {
      code: 'invalid-arguments',
      message: t('tool.error.uncallable', { name: tool.ref.id }),
    };
  }
  let outcome: ReturnType<Validator['validate']>;
  try {
    outcome = new Validator(tool.inputSchema, '2020-12', true).validate(args);
  } catch (error) {
    // A schema the validator cannot follow (an unresolvable `$ref`) checks nothing: fail closed.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      code: 'invalid-arguments',
      message: t('tool.error.unusable-schema', { name: tool.ref.id, reason }),
    };
  }
  if (outcome.valid) {
    return null;
  }
  const reason = outcome.errors.at(-1)?.error ?? '';
  return {
    code: 'invalid-arguments',
    message: t('tool.error.invalid-arguments', { name: tool.ref.id, reason }),
  };
}

/**
 * Whether `schema` can check arguments at all: a dry run against an empty object. A schema
 * whose root the validator cannot follow fails it; one that fails only for some arguments
 * is caught when a call is checked.
 */
export function isUsableSchema(schema: JsonObject): boolean {
  try {
    new Validator(schema, '2020-12', true).validate({});
    return true;
  } catch {
    return false;
  }
}

function findTool(
  registry: EntityRegistry,
  name: string,
  allowed: ReadonlySet<string> | undefined,
): Tool | null {
  const ref = { kind: 'tool', id: name, version: null } as const;
  if ((allowed !== undefined && !allowed.has(name)) || !registry.has(ref)) {
    return null;
  }
  return registry.resolve(ref);
}

/** Resolves with `timeout` after `ms`, or never when `ms` is undefined. */
function deadline(ms: number | undefined, onExpire: () => void): Promise<'timeout'> {
  return new Promise((resolve: (value: 'timeout') => void) => {
    if (ms !== undefined) {
      setTimeout(() => {
        onExpire();
        resolve('timeout');
      }, ms);
    }
  });
}

/**
 * Runs one tool call.
 *
 * The tool runs only if it is registered, allowed for the task, its arguments pass its
 * schema and `options.guard` lets it through. A thrown error, a timeout or a refusal
 * becomes `{ ok: false, error }`.
 */
export async function executeToolCall(
  registry: EntityRegistry,
  call: ToolCall,
  ctx: Omit<ToolCallContext, 'callId'>,
  options: ExecuteOptions = {},
): Promise<ToolResult> {
  const tool = findTool(registry, call.name, options.allowed);
  if (tool === null) {
    return errorResult('not-found', t('tool.error.not-found', { name: call.name }));
  }
  const invalid = validateToolArgs(tool, call.args);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    const refused = (await options.guard?.(call, ctx)) ?? null;
    if (refused !== null) {
      return { ok: false, error: refused };
    }
    const outcome = await Promise.race([
      tool.invoke(call.args, { ...ctx, callId: call.id, signal: controller.signal }),
      deadline(options.timeoutMs, abort),
    ]);
    if (outcome === 'timeout') {
      const ms = options.timeoutMs ?? 0;
      return errorResult('timeout', t('tool.error.timeout', { name: call.name, ms }));
    }
    return outcome;
  } catch (error) {
    return errorResult('failed', error instanceof Error ? error.message : String(error));
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}
