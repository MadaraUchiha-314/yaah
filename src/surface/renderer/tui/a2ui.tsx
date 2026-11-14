/**
 * The A2UI basic catalog, drawn with Ink. Layout components become boxes and text;
 * inputs become one-line controls with a visible focus mark; media becomes a label and
 * its address. What cannot be drawn is named in a fallback line and otherwise ignored.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { t } from '../../../kernel/strings.ts';
import type { A2uiSurface } from './a2ui-model.ts';
import type { A2uiControl, A2uiNode } from './a2ui-tree.ts';
import { controlsOf } from './a2ui-tree.ts';

/** Which control has the keyboard: its surface, its id, and the option the cursor is on. */
export interface A2uiFocus {
  readonly surfaceId: string;
  readonly controlId: string;
  readonly cursor: number;
}

/** Properties of {@link A2uiSurfaces}. */
export interface A2uiSurfacesProps {
  readonly surfaces: readonly A2uiSurface[];
  /** How many message batches were malformed; each is shown as one fallback line. */
  readonly rejected: number;
  /** The focused control, or null when the keyboard is elsewhere. */
  readonly focus: A2uiFocus | null;
}

const DIVIDER_WIDTH = 40;

function mark(focused: boolean): string {
  return focused ? '> ' : '  ';
}

function box(checked: boolean, multiple: boolean): string {
  if (multiple) {
    return checked ? '[x]' : '[ ]';
  }
  return checked ? '(*)' : '( )';
}

function Choice(props: {
  readonly node: Extract<A2uiControl, { kind: 'choice' }>;
  readonly cursor: number | null;
}): ReactNode {
  const { node, cursor } = props;
  return (
    <Box flexDirection="column">
      {node.label === '' ? null : <Text bold>{`  ${node.label}`}</Text>}
      {node.options.map((option, index) => (
        <Text key={option.value} bold={cursor === index}>
          {mark(cursor === index)}
          {box(node.selected.includes(option.value), node.multiple)} {option.label}
        </Text>
      ))}
    </Box>
  );
}

function Control(props: { readonly node: A2uiControl; readonly cursor: number | null }): ReactNode {
  const { node, cursor } = props;
  const focused = cursor !== null;
  if (node.kind === 'choice') {
    return <Choice node={node} cursor={cursor} />;
  }
  if (node.kind === 'button') {
    return (
      <Text bold={focused} inverse={focused}>
        {mark(focused)}[ {node.label} ]
      </Text>
    );
  }
  if (node.kind === 'checkbox') {
    return (
      <Text bold={focused}>
        {mark(focused)}
        {box(node.checked, true)} {node.label}
      </Text>
    );
  }
  if (node.kind === 'slider') {
    return (
      <Text bold={focused}>
        {mark(focused)}
        {node.label} ◀ {String(node.value)} ▶ ({String(node.min)}–{String(node.max)})
      </Text>
    );
  }
  return (
    <Text bold={focused}>
      {mark(focused)}
      {node.label}: {node.value}
      {focused ? '▍' : ''}
      {node.value === '' && !focused ? <Text dimColor>{node.placeholder}</Text> : null}
    </Text>
  );
}

function Node(props: {
  readonly node: A2uiNode;
  readonly surfaceId: string;
  readonly focus: A2uiFocus | null;
}): ReactNode {
  const { node, surfaceId, focus } = props;
  if (node.kind === 'text') {
    return <Text>{node.text}</Text>;
  }
  if (node.kind === 'divider') {
    return <Text dimColor>{'─'.repeat(DIVIDER_WIDTH)}</Text>;
  }
  if (node.kind === 'media') {
    return (
      <Text>
        {node.label}: {node.url}
      </Text>
    );
  }
  if (node.kind === 'fallback') {
    return <Text dimColor>{t('view.a2ui.fallback', { component: node.component })}</Text>;
  }
  if (node.kind === 'group') {
    return (
      <Box
        flexDirection={node.direction}
        columnGap={2}
        {...(node.framed ? { borderStyle: 'single', paddingX: 1 } : {})}
      >
        {node.children.map((child) => (
          <Node key={child.id} node={child} surfaceId={surfaceId} focus={focus} />
        ))}
      </Box>
    );
  }
  const focused = focus?.surfaceId === surfaceId && focus.controlId === node.id;
  return <Control node={node} cursor={focused ? focus.cursor : null} />;
}

/** Draws the A2UI surfaces of one answer, each in its own labelled box. */
export function A2uiSurfaces(props: A2uiSurfacesProps): ReactNode {
  const { surfaces, rejected, focus } = props;
  return (
    <Box flexDirection="column">
      {surfaces.map((surface) => (
        <Box key={surface.surfaceId} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text dimColor>{t('tui.a2ui.title')}</Text>
          {surface.root === null ? null : (
            <Node node={surface.root} surfaceId={surface.surfaceId} focus={focus} />
          )}
          {controlsOf(surface.root).length === 0 ? null : (
            <Text dimColor>{t('tui.a2ui.hint')}</Text>
          )}
        </Box>
      ))}
      {Array.from({ length: rejected }, (_unused, index) => (
        <Text key={index} dimColor>
          {t('view.a2ui.fallback', { component: t('tui.a2ui.message') })}
        </Text>
      ))}
    </Box>
  );
}
