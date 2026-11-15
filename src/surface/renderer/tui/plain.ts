/**
 * The terminal UI without a terminal to draw on: when output is piped, or colour is
 * declined with `NO_COLOR`, the conversation is plain lines — one per event — and input
 * is read a line at a time. An A2UI form becomes numbered questions answered in one
 * line (`1,1,n`).
 */
import { createInterface } from 'node:readline';

import { t } from '../../../kernel/strings.ts';
import type { TranscriptItem } from '../../view.ts';
import type { A2uiControl, A2uiNode } from './a2ui-tree.ts';
import { titleOf } from './a2ui-tree.ts';
import type { TuiController } from './controller.ts';
import { sanitizeView } from './filter.ts';
import type { ActiveForm, FormEntry } from './keys.ts';
import { activeForm } from './keys.ts';
import { describeFile, formatDuration } from './transcript.tsx';

/** Where plain mode writes. */
export interface PlainOutput {
  write(text: string): unknown;
}

const YES = new Set(['y', 'yes', 'true']);
const NO = new Set(['n', 'no', 'false']);

/** The questions of a form: every control but the buttons, then the buttons if there is a choice. */
function questionsOf(form: ActiveForm): { inputs: FormEntry[]; buttons: FormEntry[] } {
  return {
    inputs: form.entries.filter((entry) => entry.control.kind !== 'button'),
    buttons: form.entries.filter((entry) => entry.control.kind === 'button'),
  };
}

function numbered(labels: readonly string[]): string {
  return labels.map((label, index) => `(${String(index + 1)}) ${label}`).join(' ');
}

/** One question as a line, and the answer that would keep the control as it is. */
function question(control: A2uiControl): readonly [text: string, example: string] {
  if (control.kind === 'choice') {
    const chosen = control.options.findIndex((option) => control.selected.includes(option.value));
    const options = numbered(control.options.map((option) => option.label));
    return [`${control.label} ${options}`, String(Math.max(chosen, 0) + 1)];
  }
  if (control.kind === 'checkbox') {
    return [`${control.label} ${t('tui.plain.form.yesno')}`, control.checked ? 'y' : 'n'];
  }
  if (control.kind === 'slider') {
    const range = t('tui.plain.form.range', { min: control.min, max: control.max });
    return [`${control.label} ${range}`, String(control.value)];
  }
  const value = control.kind === 'field' && control.value !== '' ? control.value : '-';
  return [`${control.label} ${t('tui.plain.form.text')}`, value];
}

/** The value an answer gives a control, or undefined when the answer does not fit it. */
function answerFor(control: A2uiControl, answer: string): unknown {
  if (control.kind === 'choice') {
    const option = control.options[Number(answer) - 1];
    return option === undefined ? undefined : [option.value];
  }
  if (control.kind === 'checkbox') {
    const word = answer.toLowerCase();
    return YES.has(word) || NO.has(word) ? YES.has(word) : undefined;
  }
  if (control.kind === 'slider') {
    const value = Number(answer);
    return answer !== '' && value >= control.min && value <= control.max ? value : undefined;
  }
  return control.kind === 'field' ? answer : undefined;
}

function fallbacks(node: A2uiNode | null): string[] {
  if (node?.kind === 'group') {
    return node.children.flatMap((child) => fallbacks(child));
  }
  return node?.kind === 'fallback' ? [t('view.a2ui.fallback', { component: node.component })] : [];
}

/** Prints a controller's state as lines, each entry of the transcript once. */
class PlainPrinter {
  readonly #controller: TuiController;
  readonly #out: PlainOutput;
  readonly #printed = new Set<string>();
  #state = '';

  constructor(controller: TuiController, out: PlainOutput) {
    this.#controller = controller;
    this.#out = out;
  }

  line(text: string): void {
    this.#out.write(`${text}\n`);
  }

  /** Prints what is new and settled since the last call. */
  flush(): void {
    const { view, busy } = this.#controller.getState();
    for (const item of sanitizeView(view).items) {
      const key = `${item.kind}/${item.id}`;
      const settled = item.kind === 'agent' ? !item.streaming : item.kind !== 'tool' || item.done;
      if (settled && !this.#printed.has(key)) {
        this.#printed.add(key);
        this.#item(item);
      }
    }
    // While a turn runs the task is working, whatever the last event said.
    const shown = busy ? 'working' : view.state;
    const form = busy ? null : activeForm(this.#controller, view);
    const state = `${shown}/${form?.itemId ?? ''}`;
    if (state !== this.#state && shown !== 'idle') {
      this.#state = state;
      this.#stateLine(t(`view.state.${shown}`).toLowerCase(), form);
    }
  }

  #stateLine(state: string, form: ActiveForm | null): void {
    const { inputs, buttons } = form === null ? { inputs: [], buttons: [] } : questionsOf(form);
    const examples = inputs.map((entry) => question(entry.control)[1]);
    if (buttons.length > 1) {
      examples.push('1');
    }
    this.line(
      examples.length === 0
        ? t('tui.plain.state', { state })
        : t('tui.plain.form.answer', { state, example: examples.join(',') }),
    );
  }

  #item(item: TranscriptItem): void {
    if (item.kind === 'agent') {
      if (item.text !== '') {
        this.line(t('tui.plain.agent', { text: item.text }));
      }
      if (item.a2ui.length > 0) {
        this.#form(item.id, item.a2ui);
      }
    } else if (item.kind === 'ask') {
      this.line(t('tui.plain.ask', { label: t('view.ask.label').toLowerCase(), text: item.text }));
    } else if (item.kind === 'note') {
      this.line(t('tui.plain.note', { text: item.text }));
    } else if (item.kind === 'file') {
      const who = t(item.from === 'user' ? 'tui.label.user' : 'tui.label.agent');
      this.line(t('tui.plain.file', { who, file: describeFile(item) }));
    } else if (item.kind === 'tool') {
      const duration = item.durationMs === null ? '' : formatDuration(item.durationMs);
      this.line(
        item.ok
          ? t('tui.plain.tool.ok', {
              name: item.name,
              status: t('view.tool.ok'),
              duration,
            }).trimEnd()
          : t('tui.plain.tool.failed', { name: item.name, status: t('view.tool.failed') }),
      );
    }
  }

  #form(itemId: string, batches: readonly unknown[]): void {
    const model = this.#controller.model(itemId, batches);
    for (const { root } of model.surfaces()) {
      this.line(t('tui.plain.form', { title: titleOf(root) }));
      for (const fallback of fallbacks(root)) {
        this.line(`  ${fallback}`);
      }
    }
    for (let index = 0; index < model.rejected; index += 1) {
      this.line(`  ${t('view.a2ui.fallback', { component: t('tui.a2ui.message') })}`);
    }
    const form = activeForm(this.#controller, this.#controller.getState().view);
    if (form?.itemId !== itemId) {
      return;
    }
    const { inputs, buttons } = questionsOf(form);
    const lines = inputs.map((entry) => question(entry.control)[0]);
    if (buttons.length > 1) {
      const labels = buttons.map((entry) => ('label' in entry.control ? entry.control.label : ''));
      lines.push(`${t('tui.plain.form.choose')} ${numbered(labels)}`);
    }
    for (const [index, text] of lines.entries()) {
      this.line(`  ${String(index + 1)}. ${text}`);
    }
  }
}

/**
 * Reads a line as the answers to the active form. When it fits — one answer per
 * question — the answers are set and the form's button is pressed; returns whether it did.
 */
async function answerForm(controller: TuiController, line: string): Promise<boolean> {
  const form = activeForm(controller, controller.getState().view);
  if (form === null) {
    return false;
  }
  const { inputs, buttons } = questionsOf(form);
  const answers = line.split(',').map((answer) => answer.trim());
  const pick = buttons.length > 1 ? Number(answers.pop()) - 1 : 0;
  const button = buttons[pick];
  const values = inputs.map((entry, index) => answerFor(entry.control, answers[index] ?? ''));
  if (button === undefined || answers.length !== inputs.length || values.includes(undefined)) {
    return false;
  }
  for (const [index, entry] of inputs.entries()) {
    form.model.set(entry.surfaceId, entry.control.id, values[index]);
  }
  const action = await form.model.activate(button.surfaceId, button.control.id);
  if (action !== null) {
    await controller.act(action);
  }
  return action !== null;
}

async function handleLine(controller: TuiController, line: string): Promise<void> {
  const text = line.trim();
  if (text === '/complete') {
    await controller.complete();
  } else if (text === '/cancel') {
    await controller.cancel();
  } else if (text === '/temporal') {
    controller.showTemporal();
  } else if (!(await answerForm(controller, text))) {
    await controller.submit(text);
  }
}

/**
 * Runs the interface in plain-line mode until the user enters `/exit`, the input ends, or
 * the controller is left from elsewhere.
 * Lines are handled one at a time, each after the turn before it has finished.
 */
export async function runPlain(
  controller: TuiController,
  stdin: NodeJS.ReadableStream,
  stdout: PlainOutput,
): Promise<void> {
  const printer = new PlainPrinter(controller, stdout);
  printer.line(t('tui.plain.hint'));
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const stop = controller.subscribe(() => {
    printer.flush();
    if (controller.getState().exited) {
      // Left from elsewhere (the process was asked to stop): stop waiting for input.
      lines.close();
    }
  });
  try {
    for await (const line of controller.getState().exited ? [] : lines) {
      // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order
      await handleLine(controller, line);
      if (controller.getState().exited) {
        break;
      }
    }
  } finally {
    lines.close();
    stop();
    controller.exit();
  }
}
