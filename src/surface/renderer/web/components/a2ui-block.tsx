/**
 * Draws the A2UI an answer carries, with the official React renderer. Whatever cannot be
 * drawn safely becomes a line of text; nothing an agent sends can make this throw.
 */
import type { MarkdownComponentProps } from '@a2ui/react';
import { A2uiSurface, MarkdownComponentContext } from '@a2ui/react';
import type { ReactNode } from 'react';
import { Component, useEffect, useRef, useState } from 'react';

import { t } from '../../../../kernel/strings.ts';
import { Fallback } from '../a2ui/catalog.tsx';
import type { ActionMessage } from '../a2ui/stage.ts';
import { A2uiStage } from '../a2ui/stage.ts';
import { watchControls } from '../a2ui/label-repair.ts';
import { plainText } from '../lib/text.ts';

/** Catches a surface that fails while rendering and shows the fallback line instead. */
export class SurfaceBoundary extends Component<
  { readonly name: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state: { readonly failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <Fallback component={this.props.name} /> : this.props.children;
  }
}

/** A2UI `Text` holds Markdown; the chat shows it as plain text, so no markup is interpreted. */
function PlainMarkdown({ markdown }: MarkdownComponentProps): ReactNode {
  return <span className="whitespace-pre-wrap">{plainText(markdown)}</span>;
}

/** Props of {@link A2uiBlock}. */
export interface A2uiBlockProps {
  /** The A2UI message batches of one answer, in arrival order. */
  readonly batches: readonly unknown[];
  /** Receives a user's action as the A2UI 1.0 `action` message to send to the agent. */
  readonly onAction: (message: ActionMessage) => void;
}

/** The surfaces of one answer. */
export function A2uiBlock({ batches, onAction }: A2uiBlockProps): ReactNode {
  const latest = useRef(onAction);
  latest.current = onAction;
  const [stage] = useState(
    () =>
      new A2uiStage((message) => {
        latest.current(message);
      }),
  );
  useEffect(
    () => (): void => {
      stage.dispose();
    },
    [stage],
  );
  const { surfaces, refused } = stage.feed(batches);
  if (surfaces.length === 0 && refused.length === 0) {
    return null;
  }
  return (
    <MarkdownComponentContext.Provider value={PlainMarkdown}>
      {surfaces.map((surface) => (
        <section
          key={surface.id}
          ref={watchControls}
          data-slot="a2ui"
          aria-label={t('web.a2ui.label')}
          className="a2ui-card grid max-w-md gap-3 rounded-xl border bg-card p-4"
        >
          <SurfaceBoundary name={surface.id}>
            <A2uiSurface surface={surface} />
          </SurfaceBoundary>
        </section>
      ))}
      {refused.map((component, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- refusals are append-only
        <Fallback key={index} component={plainText(component)} />
      ))}
    </MarkdownComponentContext.Provider>
  );
}
