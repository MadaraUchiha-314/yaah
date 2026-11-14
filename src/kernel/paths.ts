/** Path containment: the one check behind every "load only from this directory" rule. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { YaahError } from './yaah-error.ts';
import { t } from './strings.ts';

/**
 * Resolves `candidate` against `root` and returns its real path, provided that path —
 * after every symbolic link is followed — is `root` itself or lies inside it.
 *
 * @throws YaahError `path.escape` when it lies outside, and `path.missing` when the root
 *   or the candidate does not exist.
 */
export async function resolveInside(root: string, candidate: string): Promise<string> {
  let realRoot = '';
  let real = '';
  try {
    realRoot = await realpath(root);
    real = await realpath(resolve(realRoot, candidate));
  } catch (error) {
    throw new YaahError('path.missing', t('error.path.missing', { path: candidate, root }), error);
  }
  const between = relative(realRoot, real);
  if (between === '..' || between.startsWith(`..${sep}`) || isAbsolute(between)) {
    throw new YaahError('path.escape', t('error.path.escape', { path: candidate, root }));
  }
  return real;
}
