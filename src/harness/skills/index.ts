/**
 * The skills plugin: registers every valid Agent Skill under `config.skills.paths` as a
 * `skill` entity, shows the model each skill's name and description — never its body —
 * and registers `load_skill` and `read_skill_file`. Provides the `skills` service, which
 * the agent-plugin loader uses for the skills a plugin ships.
 *
 * A skill that breaks a rule is refused and reported; the others load and the harness
 * starts.
 */
import { resolve } from 'node:path';

import type { Context } from 'cordis';

import type { EntityRegistry } from '../../kernel/registry.ts';
import { registerEntity } from '../../kernel/registry.ts';
import { sanitizeDescription } from '../core/context/builder.ts';
import { renderPrompt } from '../system-prompt/prompt.ts';
import type { SkillRule } from './frontmatter.ts';
import { SkillValidationError } from './frontmatter.ts';
import type { Skill, SkillRefusal, SkillScan } from './skill.ts';
import { scanSkills } from './skill.ts';
import { createSkillTools } from './tools.ts';

export {
  SKILL_LIMITS,
  SkillValidationError,
  splitSkillMd,
  validateFrontMatter,
} from './frontmatter.ts';
export type { SkillFrontMatter, SkillRule } from './frontmatter.ts';
export { MAX_SKILL_FILE_BYTES, SkillRoot, scanSkills } from './skill.ts';
export type { Skill, SkillRefusal, SkillScan } from './skill.ts';
export { LOAD_SKILL, READ_SKILL_FILE, createSkillTools } from './tools.ts';

/** What loading one directory of skills did. */
export interface SkillLoad {
  /** Names of the skills now registered, sorted. */
  readonly registered: readonly string[];
  readonly refused: readonly SkillRefusal[];
  /** Removes the skills this load registered. */
  dispose(): void;
}

/** The skills service. */
export interface SkillsService {
  /**
   * Registers the skills that are immediate children of `root`. A skill that breaks a
   * rule, lies outside `boundary` (default: `root`), or bears a name already registered
   * is refused, reported as a `skills/refused` event, and does not stop the others.
   * Never rejects: a `root` that does not exist is itself reported as refused.
   */
  load(root: string, boundary?: string): Promise<SkillLoad>;
}

declare module 'cordis' {
  interface Context {
    /** Agent Skills. */
    skills: SkillsService;
  }
  interface Events {
    /** Skills were registered from the directory `root`. */
    'skills/registered'(root: string, names: readonly string[]): void;
    /** A skill was found and not loaded; `message` names it and the rule it broke. */
    'skills/refused'(path: string, rule: SkillRule, message: string): void;
  }
}

export const name = 'skills';
/** The runtimes this plugin runs on: it reads skills from the file system, so a browser build refuses it. */
export const runtime: readonly string[] = ['node'];
export const inject: readonly string[] = ['entities', 'config', 'taskRuntime'];

/** Position 2 of the context: one line per skill, under the `skills` prompt when present. */
function section(registry: EntityRegistry): string {
  const lines = registry
    .list('skill')
    .map(
      (skill: Skill) =>
        `- ${skill.name}: ${sanitizeDescription(skill.description).replaceAll(/\s+/gu, ' ')}`,
    )
    .join('\n');
  if (lines === '') {
    return '';
  }
  return registry.has({ kind: 'prompt', id: 'skills', version: null })
    ? renderPrompt(registry, 'skills', { skills: lines })
    : lines;
}

async function scan(root: string, boundary: string): Promise<SkillScan> {
  try {
    return await scanSkills(root, boundary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skills: [], refused: [{ path: root, rule: 'path.missing', message }] };
  }
}

/** Starts the skills plugin. */
export async function apply(ctx: Context): Promise<void> {
  const refuse = (refusal: SkillRefusal): void => {
    ctx.emit('skills/refused', refusal.path, refusal.rule, refusal.message);
    ctx.get('log')?.record('harness.event', { event: 'skills/refused', ...refusal }, 'warn');
  };
  const load = async (root: string, boundary: string = root): Promise<SkillLoad> => {
    const found = await scan(resolve(root), resolve(boundary));
    const refused = [...found.refused];
    const disposers: (() => void)[] = [];
    const registered: string[] = [];
    for (const skill of found.skills) {
      if (ctx.entities.has(skill.ref)) {
        const { message } = new SkillValidationError(skill.name, 'name.duplicate');
        refused.push({ path: resolve(root, skill.name), rule: 'name.duplicate', message });
      } else {
        disposers.push(ctx.entities.register(skill));
        registered.push(skill.name);
      }
    }
    for (const refusal of refused) {
      refuse(refusal);
    }
    ctx.emit('skills/registered', root, registered);
    const dispose = (): void => {
      for (const undo of disposers.splice(0)) {
        undo();
      }
    };
    ctx.effect(() => dispose);
    return { registered, refused, dispose };
  };
  ctx.provide('skills', { load });
  for (const tool of createSkillTools(ctx.entities)) {
    registerEntity(ctx, tool);
  }
  ctx.effect(() => ctx.taskRuntime.setSkills(() => section(ctx.entities)));
  for (const path of ctx.config.skills.paths) {
    // oxlint-disable-next-line no-await-in-loop -- in order, so the first path wins a name
    await load(path);
  }
}
