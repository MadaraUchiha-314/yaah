/**
 * The two tools through which a model uses a skill: `load_skill` returns the body of its
 * `SKILL.md`, `read_skill_file` a file it refers to. Nothing here runs anything: a
 * skill's scripts can be read, never executed.
 */
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { ToolResult } from '../core/types.ts';
import type { Tool } from '../tools/types.ts';
import { defineTool, errorResult, textResult } from '../tools/types.ts';
import type { Skill } from './skill.ts';

/** The id of the tool that returns a skill's body. */
export const LOAD_SKILL = 'load_skill';
/** The id of the tool that returns a file of a skill. */
export const READ_SKILL_FILE = 'read_skill_file';

function field(args: unknown, name: string): string {
  const fields: Readonly<Record<string, unknown>> =
    typeof args === 'object' && args !== null ? { ...args } : {};
  const value = fields[name];
  return typeof value === 'string' ? value : '';
}

function find(registry: EntityRegistry, name: string): Skill | ToolResult {
  const ref = { kind: 'skill', id: name, version: null } as const;
  if (registry.has(ref)) {
    return registry.resolve(ref);
  }
  const known = registry
    .list('skill')
    .map((skill: Skill) => skill.name)
    .join(', ');
  return errorResult('not-found', t('skill.error.unknown', { name, known }));
}

/**
 * Decodes a file as text, or returns null when it is not text: invalid UTF-8, or a NUL
 * character.
 */
function asText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

/** A failure the model should see, worded without any path of the host. */
function failure(error: unknown): ToolResult {
  return error instanceof YaahError
    ? errorResult(error.code, error.message)
    : errorResult('failed', t('skill.error.unreadable'));
}

/**
 * Builds `load_skill` and `read_skill_file` over the skills in `registry`.
 *
 * `read_skill_file` returns text files as text. A file that is not UTF-8 text is refused
 * (`unsupported`), as is one above 256 KiB (`skill.file.too-large`) and any path that
 * leaves the skill's directory (`path.escape`): the model is told, the task goes on.
 */
export function createSkillTools(registry: EntityRegistry): readonly Tool[] {
  const name = { type: 'string', minLength: 1 } as const;
  const load = defineTool({
    id: LOAD_SKILL,
    description: t('skill.tool.load.description'),
    inputSchema: {
      type: 'object',
      properties: { name },
      required: ['name'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args) => {
      const skill = find(registry, field(args, 'name'));
      if ('ok' in skill) {
        return skill;
      }
      try {
        return textResult(await skill.loadBody());
      } catch (error) {
        return failure(error);
      }
    },
  });
  const read = defineTool({
    id: READ_SKILL_FILE,
    description: t('skill.tool.read.description'),
    inputSchema: {
      type: 'object',
      properties: { name, path: name },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args) => {
      const skill = find(registry, field(args, 'name'));
      if ('ok' in skill) {
        return skill;
      }
      const path = field(args, 'path');
      try {
        const text = asText(await skill.readFile(path));
        return text === null
          ? errorResult('unsupported', t('skill.error.binary', { path }))
          : textResult(text);
      } catch (error) {
        return failure(error);
      }
    },
  });
  return [load, read];
}
