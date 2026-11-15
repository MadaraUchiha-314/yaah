/**
 * Where the user writes: a multi-line input, the command chips, and Send. Enter sends,
 * Shift+Enter starts a new line. A command the harness lists is coloured as it is typed.
 * Images are attached from a file picker or by pasting; a voice message is recorded with
 * the microphone button and sent when the recording is stopped.
 */
import type {
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  ReactNode,
  SyntheticEvent,
  RefObject,
} from 'react';
import { useId, useRef, useState } from 'react';

import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';
import type { TurnFile } from '../../../session.ts';
import type { ViewState } from '../../../view.ts';
import { readCommand } from '../lib/command.ts';
import { cn } from '../lib/utils.ts';
import type { StartRecording } from '../use-voice.ts';
import { useVoiceInput } from '../use-voice.ts';
import type { Attachment } from './attachments.tsx';
import { AttachmentList, readAttachments } from './attachments.tsx';
import type { SpeakControl } from './composer-controls.tsx';
import { Chips, SendControls } from './composer-controls.tsx';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from './ui/input-group.tsx';

/** Props of {@link Composer}. */
export interface ComposerProps {
  /** The task's state: it decides the placeholder. */
  readonly state: ViewState;
  readonly commands: readonly CommandInfo[];
  /** True while a turn is in flight: nothing can be sent until it rests. */
  readonly busy: boolean;
  /** Sends the text, with the files attached to it — images, or one voice message. */
  readonly onSend: (text: string, files?: readonly TurnFile[]) => void;
  /** Spoken answers, when the harness offers them. */
  readonly speak?: SpeakControl | undefined;
  /** Starts a recording; the browser's microphone unless a test passes its own. */
  readonly record?: StartRecording | undefined;
}

function placeholderFor(state: ViewState, recording: boolean): string {
  if (recording) {
    return t('web.voice.recording');
  }
  if (state === 'awaiting-user-input') {
    return t('view.input.placeholder.ask');
  }
  return state === 'completed' || state === 'canceled' || state === 'failed'
    ? t('view.input.placeholder.closed')
    : t('view.input.placeholder');
}

/** The images waiting to be sent, and how they get there. */
function useAttachments(): {
  attachments: readonly Attachment[];
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
} {
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const add = (files: readonly File[]): void => {
    const read = async (): Promise<void> => {
      const added = await readAttachments(files);
      setAttachments((before) => [...before, ...added]);
    };
    void read();
  };
  const remove = (id: string): void => {
    setAttachments((before) => before.filter((attachment) => attachment.id !== id));
  };
  const clear = (): void => {
    setAttachments([]);
  };
  return { attachments, add, remove, clear };
}

/** What the composer holds and does, apart from how it is drawn. */
function useComposer(props: ComposerProps): {
  text: string;
  setText: (text: string) => void;
  attachments: readonly Attachment[];
  remove: (id: string) => void;
  voice: ReturnType<typeof useVoiceInput>;
  canSend: boolean;
  submit: (event?: SyntheticEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
} {
  const { busy, onSend } = props;
  const [text, setText] = useState('');
  const { attachments, add, remove, clear } = useAttachments();
  const voice = useVoiceInput((file) => {
    onSend('', [file]);
  }, props.record);
  const canSend = (text.trim() !== '' || attachments.length > 0) && !busy && !voice.recording;
  const submit = (event?: SyntheticEvent): void => {
    event?.preventDefault();
    if (canSend) {
      onSend(
        text.trim(),
        attachments.map((attachment) => attachment.file),
      );
      setText('');
      clear();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (images.length > 0) {
      event.preventDefault();
      add(images);
    }
  };
  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    add([...(event.target.files ?? [])]);
    event.target.value = '';
  };
  return { text, setText, attachments, remove, voice, canSend, submit, onKeyDown, onPaste, onPick };
}

/** The file input behind the attach button: images only, never drawn. */
function ImagePicker(props: {
  readonly input: RefObject<HTMLInputElement | null>;
  readonly onPick: (event: ChangeEvent<HTMLInputElement>) => void;
}): ReactNode {
  return (
    <input
      ref={props.input}
      type="file"
      accept="image/*"
      multiple
      hidden
      data-slot="attach-input"
      aria-label={t('web.attach.label')}
      onChange={props.onPick}
    />
  );
}

/** Under the input: why the microphone did not work, if it did not, and the command hint. */
function Notices(props: {
  readonly hintId: string;
  readonly hint: string;
  readonly problem: ReturnType<typeof useVoiceInput>['problem'];
}): ReactNode {
  return (
    <>
      {props.problem !== null && (
        <p role="alert" data-slot="mic-problem" className="mt-1 px-2 text-xs text-destructive">
          {t(`web.voice.problem.${props.problem}`)}
        </p>
      )}
      <p
        id={props.hintId}
        role="status"
        className="mt-1 min-h-5 px-2 text-xs text-muted-foreground"
      >
        {props.hint}
      </p>
    </>
  );
}

/** The message input and its controls. */
export function Composer(props: ComposerProps): ReactNode {
  const { state, commands, busy } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const composer = useComposer(props);
  const { text, setText, attachments, voice } = composer;
  const reading = readCommand(text, commands);
  return (
    <form onSubmit={composer.submit} className="mx-auto w-full max-w-3xl">
      <InputGroup className="rounded-2xl bg-card has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
        <AttachmentList attachments={attachments} onRemove={composer.remove} />
        <InputGroupTextarea
          ref={field}
          value={text}
          rows={2}
          // The page is the chat: the input is where typing should land when it opens.
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- see above
          autoFocus
          aria-label={t('web.input.label')}
          aria-describedby={hintId}
          placeholder={placeholderFor(state, voice.recording)}
          data-command={reading.command !== null}
          className={cn(
            'max-h-48 min-h-14 px-3 text-[0.9375rem]',
            reading.command !== null && 'font-mono text-command',
          )}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={composer.onKeyDown}
          onPaste={composer.onPaste}
        />
        <ImagePicker input={picker} onPick={composer.onPick} />
        <InputGroupAddon align="block-end" className="flex-wrap justify-between">
          <Chips
            commands={commands}
            onPick={(command) => {
              setText(command);
              field.current?.focus();
            }}
          />
          <SendControls
            canSend={composer.canSend}
            busy={busy}
            recording={voice.recording}
            speak={props.speak}
            onAttach={() => picker.current?.click()}
            onMic={voice.toggle}
          />
        </InputGroupAddon>
      </InputGroup>
      <Notices hintId={hintId} hint={reading.hint} problem={voice.problem} />
    </form>
  );
}
