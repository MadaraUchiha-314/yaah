/**
 * What the terminal UI does, apart from how it is drawn: it holds the view of the
 * current task, sends turns, completes and cancels, and keeps the A2UI state of each
 * answer. The Ink application and the plain-line mode are two faces of this one class.
 */
import { t } from '../../../kernel/strings.ts';
import type { HarnessSession } from '../../session.ts';
import type { TaskView, TranscriptItem } from '../../view.ts';
import { EMPTY_VIEW, isOpen } from '../../view.ts';
import type { A2uiAction } from './a2ui-model.ts';
import { A2uiModel } from './a2ui-model.ts';
import type { Followable } from '../../attach.ts';
import { attach } from '../../attach.ts';
import { VoiceRecorder } from './recorder.ts';

/** The part of a {@link HarnessSession} the terminal UI uses. */
export type TuiSession = Pick<
  HarnessSession,
  'send' | 'complete' | 'cancel' | 'commands' | 'dashboardUrl'
>;

/** Everything the terminal UI shows. A new object on every change. */
export interface TuiState {
  /** The task as last heard from the harness, unfiltered. */
  readonly view: TaskView;
  /** True while a turn, a completion or a cancellation is under way. */
  readonly busy: boolean;
  /** True once the user has left; nothing changes afterwards. */
  readonly exited: boolean;
  /**
   * Whether a voice message is being recorded, and how it ends: `hold` when releasing
   * the key ends it, `toggle` when pressing the key again does.
   */
  readonly recording: 'off' | 'hold' | 'toggle';
}

/** The part of a {@link VoiceRecorder} the terminal UI uses. */
export type TuiRecorder = Pick<VoiceRecorder, 'start' | 'stop'>;

/** The command that leaves the interface. */
export const EXIT_COMMAND = '/exit';

/**
 * The state and the operations of one terminal UI.
 *
 * Invariant: no operation rejects. A failure talking to the harness is shown as a note
 * in the transcript, and the interface stays usable.
 */
export class TuiController {
  readonly session: TuiSession;
  readonly #listeners = new Set<() => void>();
  readonly #models = new Map<string, A2uiModel>();
  readonly #recorder: TuiRecorder;
  #state: TuiState = { view: EMPTY_VIEW, busy: false, exited: false, recording: 'off' };
  /** Set while the recorder is starting: what to do with the recording once it runs. */
  #starting: { stop: boolean; send: boolean } | null = null;
  #notes = 0;
  /** Counts turns and closings; a stream started under an older count is void. */
  #generation = 0;
  /** The generation of the turn whose stream is still being read, or null. */
  #streaming: number | null = null;
  /** Stops following other surfaces. */
  #detach: () => void = () => undefined;

  /** @param recorder Records voice messages; the system's recorder unless given. */
  constructor(session: TuiSession, recorder: TuiRecorder = new VoiceRecorder()) {
    this.session = session;
    this.#recorder = recorder;
  }

  /**
   * Shows what other surfaces do on the current task while this one is not in a turn.
   * With `adopt`, it first takes up the task that is already open on the harness.
   */
  attach(session: Followable, adopt = false): void {
    this.#detach();
    this.#detach = attach(session, {
      adopt,
      current: () => this.#state.view,
      busy: () => this.#state.busy || this.#state.exited,
      show: (view: TaskView) => {
        this.#set({ view });
      },
    });
  }

  /** The current state. The same object until something changes. */
  readonly getState = (): TuiState => this.#state;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The Temporal address of the open task, else of the harness, else null. */
  get temporalUrl(): string | null {
    return this.#state.view.workflowUrl ?? this.session.dashboardUrl;
  }

  /**
   * Handles a line the user entered: `/exit` leaves, anything else is sent as a turn.
   * A closed task is not continued — the session starts a new one. Ignored while busy.
   */
  async submit(text: string): Promise<void> {
    const line = text.trim();
    if (line === EXIT_COMMAND) {
      this.exit();
      return;
    }
    if (line !== '') {
      await this.#turn(() => this.session.send({ text: line }, this.#state.view));
    }
  }

  /** Sends a user's action on an A2UI surface back to the agent. */
  async act(action: A2uiAction): Promise<void> {
    const a2uiAction = { version: '1.0', action };
    await this.#turn(() => this.session.send({ text: '', a2uiAction }, this.#state.view));
  }

  /**
   * Starts recording a voice message. When no recorder program exists, or it cannot
   * start, a note says so and nothing else changes: typing works as before.
   *
   * @param hold True when the key that started it will report its release.
   */
  async startVoice(hold: boolean): Promise<void> {
    const { busy, exited, recording } = this.#state;
    if (busy || exited || recording !== 'off' || this.#starting !== null) {
      return;
    }
    this.#starting = { stop: false, send: true };
    const outcome = await this.#recorder.start();
    const asked = this.#starting;
    this.#starting = null;
    if (!outcome.ok) {
      this.note(
        outcome.reason === 'no-recorder'
          ? t('tui.voice.unavailable')
          : t('tui.voice.failed', { reason: outcome.message }),
      );
      return;
    }
    this.#set({ recording: hold ? 'hold' : 'toggle' });
    if (asked.stop) {
      // The key was released before the recorder was running.
      await this.stopVoice(asked.send);
    }
  }

  /** Ends the recording; sends it as the user's turn unless `send` is false. */
  async stopVoice(send = true): Promise<void> {
    if (this.#starting !== null) {
      this.#starting = { stop: true, send };
      return;
    }
    if (this.#state.recording === 'off') {
      return;
    }
    this.#set({ recording: 'off' });
    const file = await this.#recorder.stop();
    if (!send) {
      return;
    }
    if (file === null) {
      this.note(t('tui.voice.empty'));
      return;
    }
    await this.#turn(() => this.session.send({ text: '', files: [file] }, this.#state.view));
  }

  /** Completes the open task. Does nothing when there is none. */
  async complete(): Promise<void> {
    await this.#close((view) => this.session.complete(view));
  }

  /** Cancels the open task, also in the middle of a turn. Does nothing when there is none. */
  async cancel(): Promise<void> {
    await this.#close((view) => this.session.cancel(view), true);
  }

  /** Adds the Temporal address of the task (or of the harness) to the transcript. */
  showTemporal(): void {
    const url = this.temporalUrl;
    this.note(url === null ? t('tui.temporal.none') : t('tui.status.temporal', { url }));
  }

  /** Adds a note of the interface's own to the transcript. */
  note(text: string): void {
    this.#notes += 1;
    const item: TranscriptItem = { kind: 'note', id: `tui-note-${String(this.#notes)}`, text };
    this.#set({ view: { ...this.#state.view, items: [...this.#state.view.items, item] } });
  }

  /**
   * The A2UI state of the answer `itemId`, brought up to date with `batches` — the
   * batches the answer carries now. The state lives as long as the interface, so what
   * the user set on a form survives every redraw.
   */
  model(itemId: string, batches: readonly unknown[]): A2uiModel {
    const model = this.#models.get(itemId) ?? new A2uiModel();
    this.#models.set(itemId, model);
    model.apply(batches);
    return model;
  }

  /** Tells the listeners that A2UI state changed (a control was operated). */
  touch(): void {
    this.#set({});
  }

  /** Leaves the interface. */
  exit(): void {
    if (!this.#state.exited) {
      if (this.#state.recording !== 'off') {
        void this.#recorder.stop();
      }
      this.#detach();
      this.#set({ exited: true, recording: 'off' });
      for (const model of this.#models.values()) {
        model.dispose();
      }
      this.#models.clear();
    }
  }

  async #turn(start: () => AsyncIterable<TaskView>): Promise<void> {
    if (this.#state.busy || this.#state.exited) {
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;
    this.#streaming = generation;
    const before = this.#state.view.state;
    this.#set({ busy: true });
    try {
      for await (const view of start()) {
        // A cancellation that landed meanwhile makes the rest of this stream void.
        if (generation === this.#generation) {
          this.#set({ view });
        }
      }
    } catch (error) {
      if (generation === this.#generation) {
        this.#fail(error);
      }
    } finally {
      this.#streaming = this.#streaming === generation ? null : this.#streaming;
      if (generation === this.#generation) {
        // A command's reply, or a stream that broke, carries no status: the task is
        // in the state it was in before the turn.
        const { view } = this.#state;
        const state = before === 'working' ? 'idle' : before;
        this.#set({ busy: false, view: view.state === 'working' ? { ...view, state } : view });
      }
    }
  }

  async #close(end: (view: TaskView) => Promise<TaskView>, midTurn = false): Promise<void> {
    const { view, busy, exited } = this.#state;
    if (view.taskId === null || !isOpen(view) || exited || (busy && !midTurn)) {
      return;
    }
    this.#set({ busy: true });
    try {
      const closed = await end(view);
      // From here on the views of a turn still streaming are dropped.
      this.#generation += 1;
      const shown = busy ? { ...this.#state.view, state: closed.state } : closed;
      // An answer cut off by the close will not be finished: it is no longer streaming.
      const items = shown.items.map((item): TranscriptItem =>
        item.kind === 'agent' && item.streaming ? { ...item, streaming: false } : item,
      );
      this.#set({ view: { ...shown, items } });
    } catch (error) {
      this.#fail(error);
    } finally {
      // Still busy only when the close failed and the turn it interrupted goes on.
      this.#set({ busy: this.#streaming !== null && this.#streaming === this.#generation });
    }
  }

  #fail(error: unknown): void {
    this.note(t('tui.error', { message: error instanceof Error ? error.message : String(error) }));
  }

  #set(change: Partial<TuiState>): void {
    if (this.#state.exited) {
      return;
    }
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
