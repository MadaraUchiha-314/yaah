import { ArrowUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import type { TaskView } from '../../../view.ts';
import { isOpen } from '../../../view.ts';
import { plainText } from '../lib/text.ts';
import { StatePill } from './state-pill.tsx';
import { Button } from './ui/button.tsx';

/** Props of {@link TaskHeader}. */
export interface TaskHeaderProps {
  readonly view: TaskView;
  /** The harness's Temporal Web UI, used when the task has no workflow link of its own. */
  readonly dashboardUrl: string | null;
  /** True while a turn is in flight: the task cannot be completed mid-turn. */
  readonly busy: boolean;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
}

/** The link to show, or null: only `http:` and `https:` addresses are linked. */
function temporalLink(view: TaskView, dashboardUrl: string | null): string | null {
  const url = view.workflowUrl ?? dashboardUrl;
  return url !== null && /^https?:\/\//iu.test(url) ? url : null;
}

/** What the task is called: what the user first asked for, once there is a task. */
function taskName(view: TaskView): string {
  const first = view.items.find((item) => item.kind === 'user');
  return view.taskId === null || first === undefined ? t('web.task.new') : plainText(first.text);
}

/** The bar above the conversation: brand, state, task name and the task's controls. */
export function TaskHeader(props: TaskHeaderProps): ReactNode {
  const { view, busy } = props;
  const open = view.taskId !== null && isOpen(view);
  const link = temporalLink(view, props.dashboardUrl);
  const name = taskName(view);
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
      <span className="font-semibold tracking-tight">{t('agent.name')}</span>
      <div className="order-3 flex min-w-0 basis-full items-center gap-2 sm:order-none sm:flex-1 sm:basis-0">
        <StatePill state={view.state} />
        <h1 className="min-w-0 truncate text-sm font-normal text-muted-foreground" title={name}>
          {name}
        </h1>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {link !== null && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            title={t('web.temporal.title')}
            className="mr-1.5 inline-flex items-center gap-0.5 rounded-sm text-[0.8rem] text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {t('view.action.temporal')}
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </a>
        )}
        <Button variant="outline" size="sm" disabled={!open} onClick={props.onCancel}>
          {t('view.action.cancel')}
        </Button>
        <Button size="sm" disabled={!open || busy} onClick={props.onComplete}>
          {t('view.action.complete')}
        </Button>
      </div>
    </header>
  );
}
