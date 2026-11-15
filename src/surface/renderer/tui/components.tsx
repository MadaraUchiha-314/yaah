/**
 * The fixed parts of the terminal screen — status line, key hints, input line — and
 * {@link Screen}, which stacks them under the transcript the way `design/tui.html` lays
 * the terminal out.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { t } from '../../../kernel/strings.ts';
import type { TaskView, ViewState } from '../../view.ts';
import { isOpen } from '../../view.ts';
import { sanitize } from './filter.ts';
import type { ModelLookup, TranscriptFocus } from './transcript.tsx';
import { Transcript } from './transcript.tsx';

/** A command as the input line needs it: its name, without the slash. */
export interface CommandName {
  readonly name: string;
}

/** What is known about the task beyond its view; all of it optional. */
export interface TaskDetails {
  /** The task's name, when the harness gave it one. */
  readonly taskName?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

/** Properties of {@link StatusLine}. */
export interface StatusLineProps extends TaskDetails {
  readonly view: TaskView;
  /** The Temporal Web UI of the harness, or null. The task's own address wins over it. */
  readonly dashboardUrl: string | null;
}

/** Properties of {@link InputLine}. */
export interface InputLineProps {
  readonly text: string;
  readonly commands: readonly CommandName[];
  readonly state: ViewState;
  /** Whether the keyboard is on the input line (and not on an A2UI control). */
  readonly focused: boolean;
}

/** Properties of {@link Screen}. */
export interface ScreenProps extends StatusLineProps, InputLineProps {
  readonly models: ModelLookup;
  readonly focus: TranscriptFocus | null;
  /** True while a turn is under way. */
  readonly busy: boolean;
}

/** The state's glyph and colour. The glyph and the words carry the meaning; colour only adds. */
const STATE_MARK: Readonly<Record<ViewState, readonly [glyph: string, color: string]>> = {
  idle: ['○', 'gray'],
  working: ['◐', 'cyan'],
  'awaiting-next-interaction': ['●', 'green'],
  'awaiting-user-input': ['▲', 'yellow'],
  completed: ['✓', 'green'],
  canceled: ['■', 'gray'],
  failed: ['✗', 'red'],
};

const RULE_WIDTH = 80;
const SEPARATOR = ' · ';

/**
 * The command a line of input invokes: the name after the slash when it is one of
 * `commands`, else null.
 */
export function matchCommand(text: string, commands: readonly CommandName[]): string | null {
  if (!text.startsWith('/')) {
    return null;
  }
  const [word = ''] = text.slice(1).split(/\s/u);
  return commands.some((command) => command.name === word) ? word : null;
}

/** The task's state in words with its glyph, then what else is known about the task. */
export function StatusLine(props: StatusLineProps): ReactNode {
  const { view, taskName, model, effort } = props;
  const [glyph, color] = STATE_MARK[view.state];
  const url = view.workflowUrl ?? props.dashboardUrl;
  const details = [
    taskName ?? '',
    model ?? '',
    effort === null || effort === undefined ? '' : t('tui.status.effort', { effort }),
    url === null ? '' : t('tui.status.temporal', { url }),
  ].filter((detail) => detail !== '');
  return (
    <Text>
      <Text color={color} bold>
        {glyph} {t(`view.state.${view.state}`)}
      </Text>
      {details.map((detail) => `${SEPARATOR}${sanitize(detail)}`).join('')}
    </Text>
  );
}

/** The keys that work right now. */
export function KeyHints(props: { readonly view: TaskView; readonly busy: boolean }): ReactNode {
  const { view, busy } = props;
  const open = view.taskId !== null && isOpen(view);
  const hints = [
    open && !busy ? t('tui.hint.complete') : '',
    open ? t('tui.hint.cancel') : '',
    open ? '' : t('tui.hint.new'),
    t('tui.hint.temporal'),
    busy ? t('tui.hint.leave') : t('tui.hint.exit'),
  ].filter((hint) => hint !== '');
  return <Text dimColor>{hints.join(SEPARATOR)}</Text>;
}

function placeholder(state: ViewState): string {
  if (state === 'awaiting-user-input') {
    return t('view.input.placeholder.ask');
  }
  return state === 'completed' || state === 'canceled' || state === 'failed'
    ? t('view.input.placeholder.closed')
    : t('view.input.placeholder');
}

/**
 * The prompt and what the user has typed. A typed command is set off in its own colour
 * and explained in a line below; a slash that matches no command lists the commands.
 */
export function InputLine(props: InputLineProps): ReactNode {
  const { text, commands, focused } = props;
  const command = matchCommand(text, commands);
  const head = command === null ? '' : `/${command}`;
  const names = commands.map((entry) => `/${sanitize(entry.name)}`).join(' ');
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold={focused}>{focused ? '> ' : '  '}</Text>
        <Text color="magenta" bold>
          {head}
        </Text>
        {sanitize(text.slice(head.length))}
        {focused ? '▍' : ''}
        {text === '' ? <Text dimColor> {placeholder(props.state)}</Text> : null}
      </Text>
      {command === null ? null : (
        <Text color="magenta">{t('view.command.hint', { name: head })}</Text>
      )}
      {command === null && text.startsWith('/') ? (
        <Text dimColor>{t('view.command.list', { names })}</Text>
      ) : null}
    </Box>
  );
}

function Rule(): ReactNode {
  return <Text dimColor>{'─'.repeat(RULE_WIDTH)}</Text>;
}

/** The whole screen: transcript, input line, status line and key hints. */
export function Screen(props: ScreenProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Transcript view={props.view} models={props.models} focus={props.focus} />
      <Rule />
      <InputLine
        text={props.text}
        commands={props.commands}
        state={props.view.state}
        focused={props.focused}
      />
      <Rule />
      <StatusLine
        view={props.view}
        dashboardUrl={props.dashboardUrl}
        taskName={props.taskName ?? null}
        model={props.model ?? null}
        effort={props.effort ?? null}
      />
      <KeyHints view={props.view} busy={props.busy} />
    </Box>
  );
}
