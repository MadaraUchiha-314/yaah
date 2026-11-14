import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import type { ViewState } from '../../../view.ts';
import { cn } from '../lib/utils.ts';
import { Badge } from './ui/badge.tsx';

/** How each state is tinted. The words carry the meaning; the tint only supports them. */
const TONE: Readonly<Record<ViewState, string>> = {
  idle: 'text-muted-foreground',
  working: 'text-foreground',
  'awaiting-next-interaction': 'text-muted-foreground',
  'awaiting-user-input': 'border-attention bg-attention-soft text-attention',
  completed: 'border-transparent bg-ok-soft text-ok',
  canceled: 'text-muted-foreground',
  failed: 'border-destructive text-destructive',
};

/** The task's state, in words, as a pill. */
export function StatePill({ state }: { readonly state: ViewState }): ReactNode {
  return (
    <Badge
      variant="outline"
      role="status"
      data-slot="state-pill"
      data-state={state}
      className={cn('h-6 gap-1.5 px-2', TONE[state])}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full bg-current',
          state === 'working' && 'motion-safe:animate-pulse',
        )}
      />
      {t(`view.state.${state}`)}
    </Badge>
  );
}
