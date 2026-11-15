import { WrenchIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import type { ToolItem } from '../lib/blocks.ts';
import { formatDuration, plainText } from '../lib/text.ts';
import { cn } from '../lib/utils.ts';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './ui/trace.tsx';

/** The outcome of one call, in words. */
function outcome(call: ToolItem): string {
  if (!call.done) {
    return t('view.tool.running');
  }
  return call.ok ? t('view.tool.ok') : t('view.tool.failed');
}

function ToolRow({ call }: { readonly call: ToolItem }): ReactNode {
  const failed = call.done && !call.ok;
  return (
    <li
      data-slot="tool-call"
      className="flex items-baseline justify-between gap-3 py-1 font-mono text-xs"
    >
      <span className="min-w-0 truncate text-foreground">{plainText(call.name)}</span>
      <span
        className={cn(
          'flex shrink-0 gap-2',
          failed && 'text-destructive',
          call.done && call.ok && 'text-ok',
        )}
      >
        <span>{outcome(call)}</span>
        {call.durationMs !== null && <span>{formatDuration(call.durationMs)}</span>}
      </span>
    </li>
  );
}

/**
 * Tool calls that ran next to each other, as one collapsible group: a summary line, and
 * under it each call with its outcome and how long it took. Open until the user folds it.
 */
export function ToolGroup({ calls }: { readonly calls: readonly ToolItem[] }): ReactNode {
  const failed = calls.filter((call) => call.done && !call.ok).length;
  const running = calls.some((call) => !call.done);
  const summary =
    calls.length === 1
      ? t('web.tools.summary.one')
      : t('web.tools.summary', { count: calls.length });
  return (
    <Trace data-slot="tool-group">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine {...(running ? { status: 'running' as const } : {})}>
            <TraceIcon>
              <WrenchIcon />
            </TraceIcon>
            <TraceTitle>{summary}</TraceTitle>
            {failed > 0 && (
              <TraceDescription className="text-destructive">
                {t('web.tools.failed', { count: failed })}
              </TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ul className="m-0 list-none p-0">
            {calls.map((call) => (
              <ToolRow key={call.id} call={call} />
            ))}
          </ul>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
