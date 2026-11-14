/**
 * The files of one agent plugin. Every read goes through here, and through
 * `resolveInside`: with symbolic links followed, a path must stay inside the plugin's
 * root (Agent Plugins 1.0.0, §4.1).
 */
import { readFile, readdir, stat } from 'node:fs/promises';

import { resolveInside } from '../../kernel/paths.ts';
import { t } from '../../kernel/strings.ts';
import { YaahError } from '../../kernel/yaah-error.ts';
import { AgentPluginError } from './manifest.ts';

/** Read access to a plugin's directory, or to nothing for a plugin that is only in memory. */
export class PluginFiles {
  /** The real path of the plugin's root, or null. */
  readonly root: string | null;
  readonly #label: string;

  constructor(root: string | null, label: string) {
    this.root = root;
    this.#label = label;
  }

  /**
   * Opens the plugin directory `path`.
   *
   * @throws AgentPluginError `§4.1 plugin root` when `path` is not a directory.
   */
  static async open(path: string): Promise<PluginFiles> {
    try {
      const root = await resolveInside(path, '.');
      if ((await stat(root)).isDirectory()) {
        return new PluginFiles(root, path);
      }
    } catch {
      // Reported below, as the same refusal.
    }
    throw new AgentPluginError(path, '§4.1 plugin root', t('plugin.rule.root'));
  }

  /**
   * The real path of `relative`, or null when nothing is there.
   *
   * @throws AgentPluginError `§4.1 <path>: containment` when it resolves outside the root.
   */
  async resolve(relative: string): Promise<string | null> {
    if (this.root === null) {
      return null;
    }
    try {
      return await resolveInside(this.root, relative);
    } catch (error) {
      if (error instanceof YaahError && error.code === 'path.missing') {
        return null;
      }
      const detail = t('plugin.rule.containment', { path: relative });
      throw new AgentPluginError(this.#label, `§4.1 ${relative}: containment`, detail);
    }
  }

  /**
   * What `relative` is: a regular file, a directory, something else, or null when
   * nothing is there.
   *
   * @throws AgentPluginError as {@link PluginFiles.resolve}.
   */
  async kind(relative: string): Promise<'file' | 'directory' | 'other' | null> {
    const path = await this.resolve(relative);
    if (path === null) {
      return null;
    }
    const info = await stat(path);
    if (info.isFile()) {
      return 'file';
    }
    return info.isDirectory() ? 'directory' : 'other';
  }

  /**
   * The text of the regular file `relative`, or null when there is none.
   *
   * @throws AgentPluginError as {@link PluginFiles.resolve}.
   */
  async text(relative: string): Promise<string | null> {
    const path = await this.resolve(relative);
    return path !== null && (await stat(path)).isFile() ? readFile(path, 'utf8') : null;
  }

  /**
   * The names of the entries of the directory `relative`, sorted; empty when there is no
   * such directory.
   *
   * @throws AgentPluginError as {@link PluginFiles.resolve}.
   */
  async list(relative: string): Promise<readonly string[]> {
    const path = await this.resolve(relative);
    return path !== null && (await stat(path)).isDirectory()
      ? (await readdir(path)).toSorted()
      : [];
  }
}
