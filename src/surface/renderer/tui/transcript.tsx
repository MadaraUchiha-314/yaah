/**
 * The transcript of a task, drawn with Ink: what the user said, what the agent
 * answered (with its A2UI, if any), tool calls, requests for input and notes.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { t } from '../../../kernel/strings.ts';
import type { FileItem } from '../../view-files.ts';
import { fileLabel, fileLocation } from '../../view-files.ts';
import type { TaskView, TranscriptItem } from '../../view.ts';
import type { A2uiFocus } from './a2ui.tsx';
import { A2uiSurfaces } from './a2ui.tsx';
import type { A2uiModel } from './a2ui-model.ts';
import { sanitizeView } from './filter.ts';

/** Finds the A2UI state of an answer, given its id and the batches it carries. */
export type ModelLookup = (itemId: string, batches: readonly unknown[]) => A2uiModel;

/** The focused A2UI control and the answer it belongs to. */
export interface TranscriptFocus extends A2uiFocus {
  readonly itemId: string;
}

/** Properties of {@link Transcript}. */
export interface TranscriptProps {
  /** The view as the session gave it; it is filtered here before anything is drawn. */
  readonly view: TaskView;
  readonly models: ModelLookup;
  readonly focus: TranscriptFocus | null;
}

const LABEL_WIDTH = 6;
const MS_PER_SECOND = 1000;

/** A duration the way the transcript writes it: `420 ms`, `1.2 s`. */
export function formatDuration(durationMs: number): string {
  return durationMs < MS_PER_SECOND
    ? t('tui.duration.ms', { value: Math.round(durationMs) })
    : t('tui.duration.s', { value: (durationMs / MS_PER_SECOND).toFixed(1) });
}

function Line(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{props.label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {props.children}
      </Box>
    </Box>
  );
}

function Tool(props: { readonly item: Extract<TranscriptItem, { kind: 'tool' }> }): ReactNode {
  const { item } = props;
  if (!item.done) {
    return (
      <Text dimColor>
        ⠿ {item.name} {t('view.tool.running')}
      </Text>
    );
  }
  if (!item.ok) {
    return (
      <Text color="red">
        ✗ {item.name} {t('view.tool.failed')}
      </Text>
    );
  }
  return (
    <Text>
      <Text color="green">✓</Text> {item.name}{' '}
      <Text dimColor>{item.durationMs === null ? '' : formatDuration(item.durationMs)}</Text>
    </Text>
  );
}

function Agent(props: {
  readonly item: Extract<TranscriptItem, { kind: 'agent' }>;
  readonly models: ModelLookup;
  readonly focus: TranscriptFocus | null;
}): ReactNode {
  const { item, models, focus } = props;
  const model = item.a2ui.length === 0 ? null : models(item.id, item.a2ui);
  return (
    <Line label={t('tui.label.agent')}>
      {item.text === '' && !item.streaming ? null : (
        <Text>
          {item.text}
          {item.streaming ? '▍' : ''}
        </Text>
      )}
      {model === null ? null : (
        <A2uiSurfaces
          surfaces={model.surfaces()}
          rejected={model.rejected}
          focus={focus?.itemId === item.id ? focus : null}
        />
      )}
    </Line>
  );
}

/** A file as the terminal can show it: what it is, its name, and where it is. */
export function describeFile(item: FileItem): string {
  const name = item.name === '' ? '' : ` ${item.name}`;
  return `[${fileLabel(item)}]${name} — ${fileLocation(item)}`;
}

function Item(props: {
  readonly item: TranscriptItem;
  readonly models: ModelLookup;
  readonly focus: TranscriptFocus | null;
}): ReactNode {
  const { item } = props;
  if (item.kind === 'user') {
    return (
      <Line label={t('tui.label.user')}>
        <Text bold>{item.text}</Text>
      </Line>
    );
  }
  if (item.kind === 'agent') {
    return <Agent item={item} models={props.models} focus={props.focus} />;
  }
  if (item.kind === 'tool') {
    return (
      <Line label="">
        <Tool item={item} />
      </Line>
    );
  }
  if (item.kind === 'file') {
    return (
      <Line label={t(item.from === 'user' ? 'tui.label.user' : 'tui.label.agent')}>
        <Text>{describeFile(item)}</Text>
      </Line>
    );
  }
  if (item.kind === 'ask') {
    return (
      <Line label={t('tui.label.agent')}>
        <Box
          flexDirection="column"
          borderStyle="bold"
          borderColor="yellow"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
        >
          <Text bold color="yellow">
            {t('view.ask.label')}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      </Line>
    );
  }
  return (
    <Line label="">
      <Text dimColor>{item.text}</Text>
    </Line>
  );
}

/** Draws the transcript of a view, oldest entry first. */
export function Transcript(props: TranscriptProps): ReactNode {
  const view = sanitizeView(props.view);
  return (
    <Box flexDirection="column">
      {view.items.map((item) => (
        <Item
          key={`${item.kind}/${item.id}`}
          item={item}
          models={props.models}
          focus={props.focus}
        />
      ))}
    </Box>
  );
}
