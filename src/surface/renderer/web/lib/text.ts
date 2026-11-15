/**
 * What the chat does to text before showing it. The page renders text as text — never as
 * HTML — so markup is inert already; this removes the control characters that are not.
 */
import { t } from '../../../../kernel/strings.ts';

/** C0 and C1 control characters and DEL, except tab and line feed. */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what this removes
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** Removes control characters (terminal escapes, bells) from text an agent or tool produced. */
export function plainText(text: string): string {
  return text.replaceAll(CONTROL, '');
}

/** A duration in words: milliseconds below a second, seconds with one decimal above. */
export function formatDuration(ms: number): string {
  return ms < 1000
    ? t('web.tool.duration.ms', { value: Math.round(ms) })
    : t('web.tool.duration.s', { value: (ms / 1000).toFixed(1) });
}
