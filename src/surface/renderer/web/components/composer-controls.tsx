/**
 * The controls under the message input: the command chips, and at the end the buttons
 * that attach an image, record a voice message, turn spoken answers on, and send.
 */
import {
  ArrowUpIcon,
  MicIcon,
  PaperclipIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';
import { hasCommand } from '../lib/command.ts';
import { Button } from './ui/button.tsx';
import { InputGroupButton } from './ui/input-group.tsx';

/** The commands offered as chips, when the harness lists them. */
const CHIPS: readonly string[] = ['model', 'effort'];

/** Spoken answers: whether the harness offers them, and whether they are on. */
export interface SpeakControl {
  readonly on: boolean;
  readonly onToggle: () => void;
}

/** Props of {@link SendControls}. */
export interface SendControlsProps {
  readonly canSend: boolean;
  /** True while a turn is in flight: nothing new can be attached or recorded. */
  readonly busy: boolean;
  readonly recording: boolean;
  readonly onAttach: () => void;
  readonly onMic: () => void;
  /** Absent when the harness has no speech model: the toggle is not drawn. */
  readonly speak?: SpeakControl | undefined;
}

/** The chips that insert a command into the input. */
export function Chips({
  commands,
  onPick,
}: {
  readonly commands: readonly CommandInfo[];
  readonly onPick: (command: string) => void;
}): ReactNode {
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

function SpeakToggle({ speak }: { speak: SpeakControl }): ReactNode {
  const label = t(speak.on ? 'web.speak.on' : 'web.speak.off');
  return (
    <InputGroupButton
      size="icon-sm"
      variant={speak.on ? 'default' : 'outline'}
      data-slot="speak-toggle"
      aria-label={label}
      aria-pressed={speak.on}
      title={label}
      onClick={speak.onToggle}
    >
      {speak.on ? <Volume2Icon aria-hidden="true" /> : <VolumeXIcon aria-hidden="true" />}
    </InputGroupButton>
  );
}

/** The buttons at the end of the composer. */
export function SendControls(props: SendControlsProps): ReactNode {
  const { busy, recording } = props;
  const micLabel = t(recording ? 'web.voice.stop' : 'web.voice.start');
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {props.speak !== undefined && <SpeakToggle speak={props.speak} />}
      <InputGroupButton
        size="icon-sm"
        variant="outline"
        data-slot="attach"
        aria-label={t('web.attach.label')}
        title={t('web.attach.label')}
        disabled={busy || recording}
        onClick={props.onAttach}
      >
        <PaperclipIcon aria-hidden="true" />
      </InputGroupButton>
      <InputGroupButton
        size="icon-sm"
        variant={recording ? 'destructive' : 'outline'}
        data-slot="mic"
        data-recording={recording}
        aria-label={micLabel}
        aria-pressed={recording}
        title={micLabel}
        disabled={busy && !recording}
        onClick={props.onMic}
      >
        {recording ? <SquareIcon aria-hidden="true" /> : <MicIcon aria-hidden="true" />}
      </InputGroupButton>
      <InputGroupButton type="submit" size="sm" variant="default" disabled={!props.canSend}>
        {t('view.action.send')}
        <ArrowUpIcon aria-hidden="true" />
      </InputGroupButton>
    </div>
  );
}
