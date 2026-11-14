/**
 * yaah's client extension to the Agent Plugins format. The specification has neither
 * hooks nor commands; it reserves a directory named after a reverse-domain namespace for
 * what a client adds (§8). yaah's is `io.github.madarauchiha-314.yaah/`:
 *
 * - `hooks.json` — hooks, each an MCP tool of the plugin's own `mcp.json`;
 * - `commands/<name>.md` — prompt commands.
 */
import { z } from 'zod';

import type { Json } from '../../kernel/json.ts';
import { HOOK_NAMES } from '../hooks/service.ts';

/** The name of yaah's extension directory inside a plugin. */
export const EXTENSION_NAMESPACE = 'io.github.madarauchiha-314.yaah';

/** Where the JSON Schema of `hooks.json` is published in the repository. */
export const HOOKS_SCHEMA_PATH = 'specs/plugins/hooks.v1.schema.json';

const HOOKS_SCHEMA_ID =
  'https://github.com/MadaraUchiha-314/yaah/specs/plugins/hooks.v1.schema.json';

const hookEntry = z.strictObject({
  event: z.enum(HOOK_NAMES).describe('The lifecycle point the hook runs at.'),
  match: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A glob (* and ?) over the tool id for tool.* events and the agent id for agent.before. Absent: every event.',
    ),
  run: z
    .strictObject({
      type: z.literal('mcp-tool'),
      server: z.string().min(1).describe("A server of the plugin's own mcp.json."),
      tool: z.string().min(1).describe('The name of the tool on that server.'),
    })
    .describe(
      'The tool is called with the event as its arguments ({ "event": name, ...fields }) and answers { "decision": "allow" | "deny", "reason"?: string } as structured content or as JSON text. At message.received, tool.before and agent.before, anything else — an error, a timeout, a malformed answer — denies.',
    ),
});

/** The schema of `hooks.json`. Closed: an unknown field is an error. */
export const hooksFile: z.ZodType<HooksFile> = z.strictObject({
  $schema: z.string().optional(),
  hooks: z.array(hookEntry),
});

/** One hook of a file plugin. */
export interface FileHook {
  readonly event: (typeof HOOK_NAMES)[number];
  readonly match?: string | undefined;
  readonly run: { readonly type: 'mcp-tool'; readonly server: string; readonly tool: string };
}

/** The content of `hooks.json`. */
export interface HooksFile {
  readonly $schema?: string | undefined;
  readonly hooks: readonly FileHook[];
}

const jsonValue: z.ZodType<Json> = z.json();

/** The JSON Schema of `hooks.json`, by repo-relative spec path. */
export function hooksJsonSchemas(): Readonly<Record<string, Json>> {
  return {
    [HOOKS_SCHEMA_PATH]: jsonValue.parse({
      ...z.toJSONSchema(hooksFile, { io: 'input' }),
      $id: HOOKS_SCHEMA_ID,
      title: `Hooks of an agent plugin (${EXTENSION_NAMESPACE}/hooks.json)`,
    }),
  };
}
