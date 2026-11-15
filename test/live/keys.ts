/** Finds provider keys for the live suite: the environment first, then the desktop keyring. */
import { spawnSync } from 'node:child_process';

/**
 * Makes `variable` available to the harness under test and says whether it is. The key
 * is never returned or printed.
 */
export function ensureKey(variable: string, service: string): boolean {
  if ((process.env[variable] ?? '') !== '') {
    return true;
  }
  const lookup = spawnSync('secret-tool', ['lookup', 'service', service, 'project', 'yaah'], {
    encoding: 'utf8',
  });
  const key = lookup.status === 0 ? lookup.stdout.trim() : '';
  if (key === '') {
    return false;
  }
  process.env[variable] = key;
  return true;
}
