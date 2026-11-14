/**
 * `SKILL.md` as the Agent Skills specification defines it: YAML front matter between two
 * `---` lines, then a Markdown body. This file parses one and checks every rule the
 * specification states about the front matter (https://agentskills.io/specification, as
 * read on 2026-11-14; the specification carries no version number).
 */
import { parse as parseYaml } from 'yaml';

import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';

/**
 * The rules a skill can violate. The first group is the specification's; `path.*` and
 * `name.duplicate` are yaah's own (containment, and one skill per name).
 */
export type SkillRule =
  | 'frontmatter.missing'
  | 'frontmatter.yaml'
  | 'frontmatter.mapping'
  | 'name.required'
  | 'name.type'
  | 'name.length'
  | 'name.characters'
  | 'name.hyphen-edges'
  | 'name.consecutive-hyphens'
  | 'name.directory'
  | 'description.required'
  | 'description.type'
  | 'description.length'
  | 'license.type'
  | 'compatibility.type'
  | 'compatibility.length'
  | 'metadata.type'
  | 'allowed-tools.type'
  | 'name.duplicate'
  | 'path.escape'
  | 'path.missing';

/** A skill broke a rule and was not loaded. `rule` names the rule; the message says it too. */
export class SkillValidationError extends YaahError {
  readonly rule: SkillRule;

  constructor(skill: string, rule: SkillRule) {
    const detail = t(`skill.rule.${rule}`);
    super('skill.invalid', t('skill.error.invalid', { skill, rule, detail }));
    this.rule = rule;
  }
}

/** The front matter of a valid skill. */
export interface SkillFrontMatter {
  /** Equal to the name of the skill's directory. */
  readonly name: string;
  readonly description: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  /** The `allowed-tools` field, split on white space. yaah records it and grants nothing by it. */
  readonly allowedTools: readonly string[];
}

/** The longest name, description and compatibility text the specification allows. */
export const SKILL_LIMITS: {
  readonly name: number;
  readonly description: number;
  readonly compatibility: number;
} = { name: 64, description: 1024, compatibility: 500 };

const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;

/** Characters, not UTF-16 units: the specification counts characters. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits the text of a `SKILL.md` into its front matter, still unchecked, and its body.
 *
 * @throws SkillValidationError `frontmatter.missing` when the file does not start with a
 *   `---` block, `frontmatter.yaml` when the block is not YAML.
 */
export function splitSkillMd(text: string, skill: string): { front: unknown; body: string } {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const match = FRONT_MATTER.exec(source);
  if (match === null) {
    throw new SkillValidationError(skill, 'frontmatter.missing');
  }
  let front: unknown = undefined;
  try {
    front = parseYaml(match[1] ?? '');
  } catch {
    throw new SkillValidationError(skill, 'frontmatter.yaml');
  }
  return { front, body: source.slice(match[0].length) };
}

function checkName(skill: string, directory: string, name: unknown): string {
  if (name === undefined || name === null) {
    throw new SkillValidationError(skill, 'name.required');
  }
  if (typeof name !== 'string') {
    throw new SkillValidationError(skill, 'name.type');
  }
  const failed = (
    [
      ['name.length', name.length === 0 || lengthOf(name) > SKILL_LIMITS.name],
      ['name.characters', !/^[a-z0-9-]*$/u.test(name)],
      ['name.hyphen-edges', name.startsWith('-') || name.endsWith('-')],
      ['name.consecutive-hyphens', name.includes('--')],
      ['name.directory', name !== directory],
    ] as const
  ).find(([, broken]) => broken);
  if (failed !== undefined) {
    throw new SkillValidationError(skill, failed[0]);
  }
  return name;
}

function checkDescription(skill: string, description: unknown): string {
  if (description === undefined || description === null) {
    throw new SkillValidationError(skill, 'description.required');
  }
  if (typeof description !== 'string') {
    throw new SkillValidationError(skill, 'description.type');
  }
  if (description.trim() === '' || lengthOf(description) > SKILL_LIMITS.description) {
    throw new SkillValidationError(skill, 'description.length');
  }
  return description;
}

/** An optional field that must be a string when present. */
function optionalString(skill: string, value: unknown, rule: SkillRule): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SkillValidationError(skill, rule);
  }
  return value;
}

function checkMetadata(skill: string, metadata: unknown): Readonly<Record<string, string>> {
  if (metadata === undefined || metadata === null) {
    return {};
  }
  if (!isRecord(metadata)) {
    throw new SkillValidationError(skill, 'metadata.type');
  }
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new SkillValidationError(skill, 'metadata.type');
    }
    strings[key] = value;
  }
  return strings;
}

/**
 * Checks parsed front matter against the specification and returns it typed.
 *
 * Rules, in the order they are checked: the front matter is a mapping; `name` is present,
 * a string, 1–64 characters, only `a-z`, `0-9` and `-`, neither starts nor ends with a
 * hyphen, has no `--`, and equals `directory`; `description` is present, a string, not
 * blank and at most 1024 characters; `license` is a string; `compatibility` is a string of
 * 1–500 characters; `metadata` maps strings to strings; `allowed-tools` is a string.
 * Fields the specification does not define are ignored: it states no rule about them.
 *
 * @param directory the name of the directory holding the `SKILL.md`.
 * @throws SkillValidationError naming the first rule violated.
 */
export function validateFrontMatter(front: unknown, directory: string): SkillFrontMatter {
  if (!isRecord(front)) {
    throw new SkillValidationError(directory, 'frontmatter.mapping');
  }
  const name = checkName(directory, directory, front['name']);
  const description = checkDescription(directory, front['description']);
  const license = optionalString(directory, front['license'], 'license.type');
  const compatibility = optionalString(directory, front['compatibility'], 'compatibility.type');
  if (
    compatibility !== undefined &&
    (compatibility === '' || lengthOf(compatibility) > SKILL_LIMITS.compatibility)
  ) {
    throw new SkillValidationError(directory, 'compatibility.length');
  }
  const metadata = checkMetadata(directory, front['metadata']);
  const allowed = optionalString(directory, front['allowed-tools'], 'allowed-tools.type') ?? '';
  return {
    name,
    description,
    license,
    compatibility,
    metadata,
    allowedTools: allowed.split(/\s+/u).filter((tool: string) => tool !== ''),
  };
}
