/**
 * The A2UI basic catalog, reduced to what a terminal can draw. A resolved A2UI surface
 * (plain JSON: component type, resolved property values, children nested) becomes a
 * tree of {@link A2uiNode}s: text, groups, and a handful of controls. Nothing here
 * touches a terminal; the Ink components and the plain-line printer both draw this tree.
 */
import { t } from '../../../kernel/strings.ts';

/** One option of a choice control. */
export interface A2uiOption {
  readonly label: string;
  readonly value: string;
}

/** A control the user can focus and operate. */
export type A2uiControl =
  | { readonly kind: 'button'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'checkbox';
      readonly id: string;
      readonly label: string;
      readonly checked: boolean;
    }
  | {
      readonly kind: 'choice';
      readonly id: string;
      readonly label: string;
      readonly multiple: boolean;
      readonly options: readonly A2uiOption[];
      readonly selected: readonly string[];
    }
  | {
      readonly kind: 'slider';
      readonly id: string;
      readonly label: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly value: number;
    }
  | {
      readonly kind: 'field';
      readonly id: string;
      readonly label: string;
      readonly value: string;
      readonly placeholder: string;
    };

/** Anything the terminal draws for one A2UI component. */
export type A2uiNode =
  | A2uiControl
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'divider'; readonly id: string }
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly direction: 'row' | 'column';
      /** Whether the group is drawn inside a border (Card, Modal). */
      readonly framed: boolean;
      readonly children: readonly A2uiNode[];
    }
  /** Media a terminal cannot show: a label and the address, as text. */
  | { readonly kind: 'media'; readonly id: string; readonly label: string; readonly url: string }
  /** A component outside the catalog; only its type name is kept. */
  | { readonly kind: 'fallback'; readonly id: string; readonly component: string };

/** How deep a surface may nest before the rest is cut off. */
const MAX_DEPTH = 32;

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function children(values: readonly unknown[], depth: number): A2uiNode[] {
  return values.flatMap((value) => {
    const node = toNode(value, depth + 1);
    return node === null ? [] : [node];
  });
}

/** The words of a node, for a button's label. */
function labelOf(node: A2uiNode | null): string {
  if (node === null) {
    return '';
  }
  if (node.kind === 'text') {
    return node.text;
  }
  if (node.kind === 'media') {
    return `${node.label} ${node.url}`;
  }
  if (node.kind === 'group') {
    return node.children.map((child) => labelOf(child)).join(' ');
  }
  return 'label' in node ? node.label : '';
}

function group(
  id: string,
  direction: 'row' | 'column',
  framed: boolean,
  values: readonly unknown[],
  depth: number,
): A2uiNode {
  return { kind: 'group', id, direction, framed, children: children(values, depth) };
}

function choice(id: string, json: Json): A2uiNode {
  const options = list(json['options']).flatMap((option): A2uiOption[] =>
    isRecord(option) ? [{ label: text(option['label']), value: text(option['value']) }] : [],
  );
  return {
    kind: 'choice',
    id,
    label: text(json['label']),
    multiple: json['variant'] !== 'mutuallyExclusive',
    options,
    selected: list(json['value']).map((value) => text(value)),
  };
}

function slider(id: string, json: Json): A2uiNode {
  const min = number(json['min'], 0);
  const max = number(json['max'], 100);
  const steps = number(json['steps'], 0);
  const step = steps > 0 ? (max - min) / steps : Math.max(1, Math.round((max - min) / 20));
  return {
    kind: 'slider',
    id,
    label: text(json['label']),
    min,
    max,
    step,
    value: number(json['value'], min),
  };
}

function tabs(id: string, json: Json, depth: number): A2uiNode {
  const parts = list(json['tabs']).flatMap((tab, index): A2uiNode[] => {
    if (!isRecord(tab)) {
      return [];
    }
    const title: A2uiNode = {
      kind: 'text',
      id: `${id}/tab/${String(index)}`,
      text: `[ ${text(tab['title'])} ]`,
    };
    return [title, ...children([tab['child']], depth)];
  });
  return { kind: 'group', id, direction: 'column', framed: false, children: parts };
}

const MEDIA: Readonly<Record<string, string>> = {
  Image: 'tui.a2ui.image',
  Video: 'tui.a2ui.video',
  AudioPlayer: 'tui.a2ui.audio',
  Icon: 'tui.a2ui.icon',
};

type Builder = (id: string, json: Json, depth: number) => A2uiNode;

const BUILDERS: Readonly<Record<string, Builder>> = {
  Text: (id, json) => ({ kind: 'text', id, text: text(json['text']) }),
  Row: (id, json, depth) => group(id, 'row', false, list(json['children']), depth),
  Column: (id, json, depth) => group(id, 'column', false, list(json['children']), depth),
  List: (id, json, depth) =>
    group(
      id,
      json['direction'] === 'horizontal' ? 'row' : 'column',
      false,
      list(json['children']),
      depth,
    ),
  Card: (id, json, depth) => group(id, 'column', true, [json['child']], depth),
  Modal: (id, json, depth) => group(id, 'column', true, [json['trigger'], json['content']], depth),
  Divider: (id) => ({ kind: 'divider', id }),
  Tabs: tabs,
  Button: (id, json, depth) => ({
    kind: 'button',
    id,
    label: labelOf(toNode(json['child'], depth + 1)),
  }),
  CheckBox: (id, json) => ({
    kind: 'checkbox',
    id,
    label: text(json['label']),
    checked: json['value'] === true,
  }),
  ChoicePicker: choice,
  Slider: slider,
  TextField: (id, json) => ({
    kind: 'field',
    id,
    label: text(json['label']),
    value: text(json['value']),
    placeholder: text(json['placeholder']),
  }),
  DateTimeInput: (id, json) => ({
    kind: 'field',
    id,
    label: text(json['label']),
    value: text(json['value']),
    placeholder: '',
  }),
};

/**
 * Turns one resolved component (and, through its properties, its subtree) into what
 * the terminal draws.
 *
 * Never throws. A component whose type is not in the basic catalog becomes a
 * `fallback` node carrying only the type name; a component that has not arrived yet,
 * a reference cycle, or anything that is not a component yields null.
 */
export function toNode(value: unknown, depth = 0): A2uiNode | null {
  if (!isRecord(value) || depth > MAX_DEPTH) {
    return null;
  }
  const id = text(value['id']);
  const type = text(value['type']);
  const state = value['state'];
  if (state === 'pending' || state === 'cyclic') {
    return null;
  }
  const media = Object.hasOwn(MEDIA, type) ? MEDIA[type] : undefined;
  if (media !== undefined) {
    return { kind: 'media', id, label: t(media), url: text(value['url'] ?? value['name']) };
  }
  const build = Object.hasOwn(BUILDERS, type) ? BUILDERS[type] : undefined;
  if (state === 'unknown-type' || build === undefined) {
    return { kind: 'fallback', id, component: type };
  }
  return build(id, value, depth);
}

/** The controls of a tree, in the order Tab visits them. */
export function controlsOf(node: A2uiNode | null): A2uiControl[] {
  if (node === null) {
    return [];
  }
  if (node.kind === 'group') {
    return node.children.flatMap((child) => controlsOf(child));
  }
  return node.kind === 'text' ||
    node.kind === 'divider' ||
    node.kind === 'media' ||
    node.kind === 'fallback'
    ? []
    : [node];
}

/** The first line of text in a tree — a form's title — or the empty string. */
export function titleOf(node: A2uiNode | null): string {
  if (node === null) {
    return '';
  }
  if (node.kind === 'text') {
    return node.text;
  }
  if (node.kind === 'group') {
    return node.children.map((child) => titleOf(child)).find((title) => title !== '') ?? '';
  }
  return '';
}
