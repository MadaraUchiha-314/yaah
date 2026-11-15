/**
 * What each key does in the terminal UI. Kept apart from the Ink components so the
 * whole keyboard contract reads in one place: the task keys, moving focus between the
 * input line and the controls of an A2UI form, and operating the focused control.
 */
import type { A2uiModel } from './a2ui-model.ts';
import type { A2uiControl } from './a2ui-tree.ts';
import { controlsOf } from './a2ui-tree.ts';
import type { TuiController } from './controller.ts';
import type { TaskView } from '../../view.ts';
import { isOpen } from '../../view.ts';

/** The part of Ink's key description this module reads. */
export interface KeyPress {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly tab: boolean;
  readonly return: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
  readonly escape?: boolean | undefined;
  /**
   * Set by a terminal that speaks the kitty keyboard protocol: whether the key went
   * down, is repeating, or came up. Absent on every other terminal.
   */
  readonly eventType?: 'press' | 'repeat' | 'release' | undefined;
}

/** Where the keyboard is: 0 is the input line, `n` the n-th control of the form. */
export interface FocusAt {
  readonly index: number;
  /** The option the cursor is on, inside a choice control. */
  readonly cursor: number;
}

/** One control of the active form and the surface it is on. */
export interface FormEntry {
  readonly surfaceId: string;
  readonly control: A2uiControl;
}

/** The A2UI form that takes keys: the one in the latest entry of the transcript. */
export interface ActiveForm {
  readonly itemId: string;
  readonly model: A2uiModel;
  readonly entries: readonly FormEntry[];
}

/** What {@link handleKey} reads and changes. */
export interface KeyContext {
  readonly controller: TuiController;
  readonly form: ActiveForm | null;
  readonly text: string;
  readonly focus: FocusAt;
  readonly setText: (text: string) => void;
  readonly setFocus: (focus: FocusAt) => void;
}

const INPUT_LINE: FocusAt = { index: 0, cursor: 0 };

/**
 * The form the user can operate: the A2UI of the transcript's last entry, when that is
 * an answer of a task still open. An older form is drawn but takes no keys.
 */
export function activeForm(controller: TuiController, view: TaskView): ActiveForm | null {
  const item = view.items.at(-1);
  if (item?.kind !== 'agent' || item.a2ui.length === 0 || !isOpen(view)) {
    return null;
  }
  const model = controller.model(item.id, item.a2ui);
  const entries = model
    .surfaces()
    .flatMap(({ surfaceId, root }) => controlsOf(root).map((control) => ({ surfaceId, control })));
  return { itemId: item.id, model, entries };
}

function printable(input: string, key: KeyPress): boolean {
  return input !== '' && !key.ctrl && !key.meta && !key.return && !key.tab;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The new value of a control after a key, or undefined when the key changes nothing. */
function nextValue(control: A2uiControl, cursor: number, input: string, key: KeyPress): unknown {
  const pressed = key.return || input === ' ';
  if (control.kind === 'checkbox') {
    return pressed ? !control.checked : undefined;
  }
  if (control.kind === 'choice') {
    const value = control.options[cursor]?.value;
    if (!pressed || value === undefined) {
      return undefined;
    }
    if (!control.multiple) {
      return [value];
    }
    return control.selected.includes(value)
      ? control.selected.filter((selected) => selected !== value)
      : [...control.selected, value];
  }
  if (control.kind === 'slider') {
    const direction = Number(key.rightArrow) - Number(key.leftArrow);
    return direction === 0
      ? undefined
      : clamp(control.value + direction * control.step, control.min, control.max);
  }
  if (control.kind === 'field') {
    if (key.backspace || key.delete) {
      return control.value.slice(0, -1);
    }
    return printable(input, key) ? control.value + input : undefined;
  }
  return undefined;
}

/** Presses a button: runs its action and sends the result to the agent. */
async function press(controller: TuiController, form: ActiveForm, entry: FormEntry): Promise<void> {
  const action = await form.model.activate(entry.surfaceId, entry.control.id);
  if (action !== null) {
    await controller.act(action);
  }
}

function operate(
  context: KeyContext,
  form: ActiveForm,
  entry: FormEntry,
  input: string,
  key: KeyPress,
): void {
  const { controller, focus } = context;
  const { control, surfaceId } = entry;
  if (control.kind === 'button') {
    if (key.return || input === ' ') {
      context.setFocus(INPUT_LINE);
      void press(controller, form, entry);
    }
    return;
  }
  if (control.kind === 'choice' && (key.upArrow || key.downArrow)) {
    const step = key.downArrow ? 1 : -1;
    const cursor = clamp(focus.cursor + step, 0, control.options.length - 1);
    context.setFocus({ ...focus, cursor });
    return;
  }
  const value = nextValue(control, focus.cursor, input, key);
  if (value !== undefined) {
    form.model.set(surfaceId, control.id, value);
    controller.touch();
  }
}

/** Edits the input line. A line end — Enter, or one inside pasted text — sends the line. */
function editLine(context: KeyContext, input: string, key: KeyPress): void {
  const { controller, text } = context;
  const lineEnd = input.search(/[\r\n]/u);
  if (key.return || lineEnd !== -1) {
    const line = text + input.slice(0, Math.max(lineEnd, 0));
    const send = line.trim() !== '' && !controller.getState().busy;
    context.setText(send ? '' : line);
    if (send) {
      void controller.submit(line);
    }
  } else if (key.backspace || key.delete) {
    context.setText(text.slice(0, -1));
  } else if (printable(input, key)) {
    context.setText(text + input);
  }
}

function taskKey(controller: TuiController, input: string): boolean {
  if (input === 'c') {
    controller.exit();
  } else if (input === 'd') {
    void controller.complete();
  } else if (input === 'x') {
    void controller.cancel();
  } else if (input === 'o') {
    controller.showTemporal();
  } else {
    return false;
  }
  return true;
}

/**
 * The voice key: Space on an empty input line. Where the terminal reports key release
 * (the kitty keyboard protocol), holding Space records and releasing it sends. Anywhere
 * else, Space starts the recording and Space again sends it. Escape discards it.
 *
 * @returns true when the key was the voice key's and needs no further handling.
 */
function voiceKey(context: KeyContext, input: string, key: KeyPress): boolean {
  const { controller } = context;
  const { recording } = controller.getState();
  if (recording !== 'off' && key.escape === true) {
    void controller.stopVoice(false);
    return true;
  }
  const isSpace = input === ' ' && !key.ctrl && !key.meta;
  if (!isSpace || (recording === 'off' && (context.text !== '' || context.focus.index !== 0))) {
    // While recording every other key is swallowed: nothing is typed into a recording.
    return recording !== 'off';
  }
  if (key.eventType === 'release') {
    if (recording === 'hold') {
      void controller.stopVoice();
    }
  } else if (key.eventType === 'press') {
    void (recording === 'off' ? controller.startVoice(true) : controller.stopVoice());
  } else if (key.eventType === undefined) {
    void (recording === 'off' ? controller.startVoice(false) : controller.stopVoice());
  }
  return true;
}

/**
 * Carries out one key press.
 *
 * Ctrl+C leaves, Ctrl+D completes the task, Ctrl+X cancels it, Ctrl+O shows its
 * Temporal address. Tab and Shift+Tab move between the input line and the controls of
 * the active form. Space on an empty input line is the voice key. Every other key goes
 * to whatever has the focus. The release of a key, where a terminal reports it, does
 * nothing except end a held voice recording.
 */
export function handleKey(context: KeyContext, input: string, key: KeyPress): void {
  if (voiceKey(context, input, key) || key.eventType === 'release') {
    return;
  }
  if (key.ctrl && taskKey(context.controller, input)) {
    return;
  }
  const entries = context.form?.entries ?? [];
  if (key.tab) {
    const stops = entries.length + 1;
    const index = (context.focus.index + (key.shift ? stops - 1 : 1)) % stops;
    context.setFocus({ index, cursor: 0 });
    return;
  }
  const entry = entries[context.focus.index - 1];
  if (context.form === null || entry === undefined) {
    editLine(context, input, key);
  } else {
    operate(context, context.form, entry, input, key);
  }
}
