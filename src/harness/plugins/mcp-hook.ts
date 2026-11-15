/**
 * A hook that is an MCP tool: the event is the tool's arguments, the tool's answer is the
 * decision. This is how a plugin made only of files takes part in decisions without yaah
 * running a shell.
 */
import { z } from 'zod';

import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import type { ToolResult } from '../core/types.ts';
import type { HookDecision, HookEvents, HookName } from '../hooks/service.ts';
import { mcpToolId } from '../tools/mcp/naming.ts';

/** What {@link mcpToolHook} needs. */
export interface McpHookOptions {
  readonly registry: EntityRegistry;
  /** How long the tool may take to answer, in milliseconds. */
  readonly timeoutMs: number;
}

const answer = z.object({ decision: z.enum(['allow', 'deny']), reason: z.string().optional() });

function deny(key: string, params: Readonly<Record<string, string | number>>): HookDecision {
  return { decision: 'deny', reason: t(key, params) };
}

/** Reads a decision from a tool result: its structured content, or its text as JSON. */
function decisionOf(result: ToolResult, tool: string): HookDecision {
  if (!result.ok) {
    return deny('hooks.mcp.failed', { tool, reason: result.error.message });
  }
  let candidate: unknown = result.structured;
  if (candidate === undefined) {
    const [first] = result.content;
    try {
      candidate = JSON.parse(first?.type === 'text' ? first.text : '');
    } catch {
      candidate = undefined;
    }
  }
  const parsed = answer.safeParse(candidate);
  if (!parsed.success) {
    return deny('hooks.mcp.malformed', { tool });
  }
  return parsed.data.decision === 'allow'
    ? { decision: 'allow' }
    : { decision: 'deny', reason: parsed.data.reason ?? '' };
}

/**
 * Builds the function of a hook that calls the tool `tool` of the MCP server `server`.
 *
 * It never throws and fails closed: the tool not being registered (its server is down),
 * an error result, no answer within `timeoutMs`, or an answer that is not
 * `{ "decision": "allow" | "deny", "reason"?: string }` are all `deny`.
 */
export function mcpToolHook(
  options: McpHookOptions,
  event: HookName,
  target: { readonly server: string; readonly tool: string },
): (payload: HookEvents[HookName]) => Promise<HookDecision> {
  const id = mcpToolId(target.server, target.tool) ?? '';
  const ref = { kind: 'tool', id, version: null } as const;
  return async (payload: HookEvents[HookName]): Promise<HookDecision> => {
    if (!options.registry.has(ref)) {
      return deny('hooks.mcp.unavailable', { tool: id });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const expired = new Promise<null>((resolve: (value: null) => void) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, options.timeoutMs);
    });
    const about = 'key' in payload ? payload.key : '';
    try {
      const result = await Promise.race([
        options.registry.resolve(ref).invoke(
          { event, ...payload },
          {
            taskId: payload.taskId ?? '',
            callId: `hook-${event}`,
            key: about,
            signal: controller.signal,
          },
        ),
        expired,
      ]);
      return result === null
        ? deny('hooks.mcp.timeout', { tool: id, ms: options.timeoutMs })
        : decisionOf(result, id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return deny('hooks.mcp.failed', { tool: id, reason });
    } finally {
      clearTimeout(timer);
    }
  };
}
