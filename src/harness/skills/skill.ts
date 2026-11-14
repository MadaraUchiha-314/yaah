/**
 * The `skill` entity and how one is found on disk: a directory `<name>/` holding a
 * `SKILL.md`. Every path is resolved with symbolic links followed and must stay inside
 * its root — a skill cannot be used to read the rest of the machine.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Entity } from '../../kernel/entity.ts';
import { LOCAL } from '../../kernel/entity.ts';
import { resolveInside } from '../../kernel/paths.ts';
import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import type { SkillFrontMatter, SkillRule } from './frontmatter.ts';
import { SkillValidationError, splitSkillMd, validateFrontMatter } from './frontmatter.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    skill: Skill;
  }
}

/** The largest file `Skill.readFile` returns: 256 KiB. A larger one is refused, not cut. */
export const MAX_SKILL_FILE_BYTES: number = 256 * 1024;

const SKILL_FILE = 'SKILL.md';

/**
 * The directory of one skill, as an opaque handle: it gives out no path, only resolves
 * one under itself.
 */
export class SkillRoot {
  readonly #dir: string;

  /** @param dir the real path of the skill's directory. */
  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * The real path of `relativePath` under the skill's directory.
   *
   * @throws YaahError `path.escape` for an absolute path and for one that, with symbolic
   *   links followed, lies outside the directory; `path.missing` when nothing is there.
   */
  async resolve(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath) || /^[A-Za-z]:|^\\/u.test(relativePath)) {
      throw new YaahError('path.escape', t('skill.error.path', { path: relativePath }));
    }
    try {
      return await resolveInside(this.#dir, relativePath);
    } catch (error) {
      const code = error instanceof YaahError ? error.code : 'path.missing';
      const key = code === 'path.escape' ? 'skill.error.path' : 'skill.error.no-file';
      // Worded here, without the directory: this text is shown to the model.
      throw new YaahError(code, t(key, { path: relativePath }), error);
    }
  }
}

/** A registered skill: its name and description are in every context, its body is not. */
export interface Skill extends Entity<'skill'> {
  /** Equal to the entity id and to the name of the skill's directory. */
  readonly name: string;
  readonly root: SkillRoot;
  readonly metadata: SkillFrontMatter;
  /** Reads the body of `SKILL.md`, front matter removed, from disk. */
  loadBody(): Promise<string>;
  /**
   * Reads a file of the skill.
   *
   * @throws YaahError `path.escape` when `relativePath` leaves the skill's directory,
   *   `path.missing` when there is no such file, `skill.file.not-file` for a directory,
   *   `skill.file.too-large` above {@link MAX_SKILL_FILE_BYTES}.
   */
  readFile(relativePath: string): Promise<Uint8Array>;
}

/** A skill that was found and not loaded. */
export interface SkillRefusal {
  /** The directory that was refused. */
  readonly path: string;
  readonly rule: SkillRule;
  /** Names the skill and the rule. */
  readonly message: string;
}

/** What a scan of one directory of skills found. */
export interface SkillScan {
  readonly skills: readonly Skill[];
  readonly refused: readonly SkillRefusal[];
}

function buildSkill(dir: string, file: string, metadata: SkillFrontMatter): Skill {
  const root = new SkillRoot(dir);
  return {
    ref: { kind: 'skill', id: metadata.name, version: null },
    description: metadata.description,
    locality: LOCAL,
    name: metadata.name,
    root,
    metadata,
    loadBody: async () => splitSkillMd(await readFile(file, 'utf8'), metadata.name).body,
    readFile: async (relativePath: string) => {
      const path = await root.resolve(relativePath);
      const info = await stat(path);
      if (!info.isFile()) {
        throw new YaahError(
          'skill.file.not-file',
          t('skill.error.no-file', { path: relativePath }),
        );
      }
      if (info.size > MAX_SKILL_FILE_BYTES) {
        const params = { path: relativePath, limit: MAX_SKILL_FILE_BYTES };
        throw new YaahError('skill.file.too-large', t('skill.error.too-large', params));
      }
      return readFile(path);
    },
  };
}

/** Whether `error` says a path does not exist — as opposed to one that escapes. */
function isMissing(error: unknown): boolean {
  return error instanceof YaahError && error.code === 'path.missing';
}

/**
 * Loads the skill in `<root>/<name>`, or returns null when that is not a skill: not a
 * directory, or one without a regular `SKILL.md`.
 *
 * @throws SkillValidationError when it is a skill and breaks a rule.
 */
async function loadSkill(root: string, name: string, boundary: string): Promise<Skill | null> {
  let dir = '';
  let file = '';
  try {
    dir = await resolveInside(boundary, join(root, name));
    if (!(await stat(dir)).isDirectory()) {
      return null;
    }
    file = await resolveInside(boundary, join(dir, SKILL_FILE));
  } catch (error) {
    // A directory without a SKILL.md is simply not a skill.
    if (isMissing(error) && dir !== '') {
      return null;
    }
    throw new SkillValidationError(name, isMissing(error) ? 'path.missing' : 'path.escape');
  }
  if (!(await stat(file)).isFile()) {
    return null;
  }
  const { front } = splitSkillMd(await readFile(file, 'utf8'), name);
  return buildSkill(dir, file, validateFrontMatter(front, name));
}

/**
 * Finds the skills that are immediate children of `root`. Deeper directories are not
 * searched.
 *
 * A skill's directory and its `SKILL.md` must resolve, symbolic links followed, inside
 * `boundary` (by default `root` itself; for an agent plugin, the plugin's root). One that
 * does not, and one whose front matter breaks a rule, is reported in `refused` and does
 * not stop the others.
 *
 * @param root an absolute path.
 * @throws YaahError `path.missing` when `root` does not exist, `path.escape` when it lies
 *   outside `boundary`.
 */
export async function scanSkills(root: string, boundary: string = root): Promise<SkillScan> {
  const realRoot = await resolveInside(boundary, root);
  const names = (await readdir(realRoot)).toSorted();
  const skills: Skill[] = [];
  const refused: SkillRefusal[] = [];
  const loaded = await Promise.allSettled(
    names.map((name: string) => loadSkill(realRoot, name, boundary)),
  );
  for (const [index, outcome] of loaded.entries()) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value !== null) {
        skills.push(outcome.value);
      }
    } else {
      const reason: unknown = outcome.reason;
      refused.push({
        path: join(realRoot, names[index] ?? ''),
        rule: reason instanceof SkillValidationError ? reason.rule : 'path.missing',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }
  return { skills, refused };
}
