/** Canonical spellings of media types that are also written another way. */
const ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

/**
 * A media type in the form capabilities and providers compare: trimmed, lower-case, and
 * canonical (`image/jpg` is `image/jpeg`). Media types are case-insensitive, and a tool or
 * client may spell one any way.
 */
export function normaliseMediaType(mediaType: string): string {
  const lower = mediaType.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
}
