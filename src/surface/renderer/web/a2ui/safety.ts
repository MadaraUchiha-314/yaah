/**
 * What stands between an agent's A2UI messages and the page (abuse case 5). An agent is
 * an untrusted author: a batch is drawn only when every component it names is one the
 * catalog has, and a URL is used only when its scheme is on a short allow-list.
 */

/** Whether `url` may be opened in a new tab: absolute `https:` only. */
export function isSafeLink(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether `url` may be the source of an image: `https:` or an inline `data:image/`. */
export function isSafeImage(url: unknown): url is string {
  return (
    isSafeLink(url) ||
    (typeof url === 'string' && url.trim().toLowerCase().startsWith('data:image/'))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The component lists a message carries, or null when the message is not well formed. */
function componentsOf(message: unknown): readonly unknown[] | null {
  if (!isRecord(message) || message['version'] !== '1.0') {
    return null;
  }
  const lists: unknown[] = [];
  for (const key of ['createSurface', 'updateComponents']) {
    const body = message[key];
    if (body !== undefined) {
      if (!isRecord(body)) {
        return null;
      }
      const components: unknown = body['components'] ?? [];
      if (!Array.isArray(components)) {
        return null;
      }
      const listed: readonly unknown[] = components;
      lists.push(...listed);
    }
  }
  return lists;
}

/** Why a batch is not drawn. */
export type BatchProblem =
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unknown-component'; readonly component: string };

/**
 * Checks one batch of A2UI messages before it reaches the renderer.
 *
 * @param known The component names of the catalog the renderer draws with.
 * @returns The first problem found, or null when the batch may be drawn.
 */
export function inspectBatch(batch: unknown, known: ReadonlySet<string>): BatchProblem | null {
  if (!Array.isArray(batch)) {
    return { kind: 'malformed' };
  }
  for (const message of batch) {
    const components = componentsOf(message);
    if (components === null) {
      return { kind: 'malformed' };
    }
    for (const component of components) {
      const name = isRecord(component) ? component['component'] : undefined;
      if (typeof name !== 'string') {
        return { kind: 'malformed' };
      }
      if (!known.has(name)) {
        return { kind: 'unknown-component', component: name };
      }
    }
  }
  return null;
}
