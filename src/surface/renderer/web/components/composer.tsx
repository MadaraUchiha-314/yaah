/**
 * Where the user writes: a multi-line input, the command chips, and Send. Enter sends,
 * Shift+Enter starts a new line. A command the harness lists is coloured as it is typed.
 */
import { ArrowUpIcon, MicIcon, PaperclipIcon } from 'lucide-react';
import type { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import { useId, useRef, useState } from 'react';

import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';
import type { ViewState } from '../../../view.ts';
import { hasCommand, readCommand } from '../lib/command.ts';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/button.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from './ui/input-group.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/** Props of {@link Composer}. */
export interface ComposerProps {
  /** The task's state: it decides the placeholder. */
  readonly state: ViewState;
  readonly commands: readonly CommandInfo[];
  /** True while a turn is in flight: nothing can be sent until it rests. */
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
}

/** The commands offered as chips, when the harness lists them. */
const CHIPS: readonly string[] = ['model', 'effort'];

function placeholderFor(state: ViewState): string {
  if (state === 'awaiting-user-input') {
    return t('view.input.placeholder.ask');
  }
  return state === 'completed' || state === 'canceled' || state === 'failed'
    ? t('view.input.placeholder.closed')
    : t('view.input.placeholder');
}

/** A control of a later slice: present, focusable so its tooltip can be read, and inert. */
function LaterButton({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InputGroupButton
            size="icon-sm"
            variant="outline"
            aria-label={label}
            disabled
            focusableWhenDisabled
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{t('web.later')}</TooltipContent>
    </Tooltip>
  );
}

function Chips({
  commands,
  onPick,
}: Pick<ComposerProps, 'commands'> & { onPick: (command: string) => void }): ReactNode {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHIPS.filter((name) => hasCommand(commands, name)).map((name) => (
        <Button
          key={name}
          type="button"
          variant="outline"
          size="xs"
          data-slot="chip"
          title={t('web.chip.insert', { command: `/${name}` })}
          className="rounded-full font-mono font-normal text-muted-foreground"
          onClick={() => {
            onPick(`/${name} `);
          }}
        >
          {`/${name}`}
        </Button>
      ))}
    </div>
  );
}

/** The buttons at the end of the composer: the two of a later slice, and Send. */
function SendControls({ canSend }: { canSend: boolean }): ReactNode {
  return (
    <div className="ml-auto flex items-center gap-1.5">
      <LaterButton label={t('web.attach.label')}>
        <PaperclipIcon aria-hidden="true" />
      </LaterButton>
      <LaterButton label={t('web.voice.label')}>
        <MicIcon aria-hidden="true" />
      </LaterButton>
      <InputGroupButton type="submit" size="sm" variant="default" disabled={!canSend}>
        {t('view.action.send')}
        <ArrowUpIcon aria-hidden="true" />
      </InputGroupButton>
    </div>
  );
}

/** The message input and its controls. */
export function Composer({ state, commands, busy, onSend }: ComposerProps): ReactNode {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const reading = readCommand(text, commands);
  const canSend = text.trim() !== '' && !busy;
  const submit = (event?: SyntheticEvent): void => {
    event?.preventDefault();
    if (canSend) {
      onSend(text.trim());
      setText('');
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const pick = (command: string): void => {
    setText(command);
    field.current?.focus();
  };
  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-3xl">
      <InputGroup className="rounded-2xl bg-card has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
        <InputGroupTextarea
          ref={field}
          value={text}
          rows={2}
          // The page is the chat: the input is where typing should land when it opens.
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- see above
          autoFocus
          aria-label={t('web.input.label')}
          aria-describedby={hintId}
          placeholder={placeholderFor(state)}
          data-command={reading.command !== null}
          className={cn(
            'max-h-48 min-h-14 px-3 text-[0.9375rem]',
            reading.command !== null && 'font-mono text-command',
          )}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="block-end" className="flex-wrap justify-between">
          <Chips commands={commands} onPick={pick} />
          <SendControls canSend={canSend} />
        </InputGroupAddon>
      </InputGroup>
      <p id={hintId} role="status" className="mt-1 min-h-5 px-2 text-xs text-muted-foreground">
        {reading.hint}
      </p>
    </form>
  );
}
