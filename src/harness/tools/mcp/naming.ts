/**
 * How an MCP tool is named inside yaah. The entity id is also the name the model calls
 * the tool by, so it must fit what every model provider accepts.
 */

/** The longest tool name every supported model provider accepts. */
export const MAX_TOOL_ID_LENGTH = 64;

const PREFIX = 'mcp';
const SEPARATOR = '__';
const NOT_ALLOWED = /[^A-Za-z0-9_-]/gu;

function sanitise(text: string): string {
  return text.replaceAll(NOT_ALLOWED, '_');
}

/**
 * The tool entity id for `toolName` of the server `serverId`: `mcp__<server>__<tool>`,
 * with every character other than a letter, a digit, `_` or `-` replaced by `_`.
 *
 * Sanitising can map two different names to one id; the caller must check for that.
 *
 * @returns null when the tool name is empty or the id would be longer than
 *   {@link MAX_TOOL_ID_LENGTH} — a truncated id could silently name another tool.
 */
export function mcpToolId(serverId: string, toolName: string): string | null {
  if (toolName === '') {
    return null;
  }
  const id = [PREFIX, sanitise(serverId), sanitise(toolName)].join(SEPARATOR);
  return id.length > MAX_TOOL_ID_LENGTH ? null : id;
}
