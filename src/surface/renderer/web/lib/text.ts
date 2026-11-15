/**
 * What the chat does to text before showing it. The page renders text as text — never as
 * HTML — so markup is inert already; this removes the control characters that are not.
 */
import { t } from '../../../../kernel/strings.ts';

/**
 * C0 and C1 control characters and DEL, except tab and line feed; and the invisible
 * format characters that change how text reads — bidi embeddings, overrides, isolates and
 * marks, zero-width spaces, word joiners, line and paragraph separators, the byte-order
 * mark. The zero-width joiner and non-joiner stay: emoji sequences and scripts need them.
 */
const CONTROL =
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what this removes
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/gu;

/**
 * Removes control characters (terminal escapes, bells) and bidi or zero-width format
 * characters from text an agent or tool produced.
 */
export function plainText(text: string): string {
  return text.replaceAll(CONTROL, '');
}

/** A duration in words: milliseconds below a second, seconds with one decimal above. */
export function formatDuration(ms: number): string {
  return ms < 1000
    ? t('web.tool.duration.ms', { value: Math.round(ms) })
    : t('web.tool.duration.s', { value: (ms / 1000).toFixed(1) });
}
