/**
 * A surface's connection to a harness. It is the official A2A SDK client and nothing
 * else on the wire; on top of it, this class turns "send this, follow that task" into a
 * stream of {@link TaskView}s for a renderer to draw.
 */
import type { AgentCard, Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';

import type { CommandInfo } from '../app/api-server/extensions/index.ts';
import type { HarnessTarget } from '../app/harness-target.ts';
import { EXT, SCHEMAS } from '../app/api-server/extensions/index.ts';
import type { SpeechChunk } from './view-files.ts';
import { fileItems, speechChunk } from './view-files.ts';
import type { TaskView } from './view.ts';
import {
  A2UI_MEDIA_TYPE,
  EMPTY_VIEW,
  foldEvent,
  isOpen,
  viewOfTask,
  withUserMessage,
} from './view.ts';

/** The official A2A extension through which A2UI travels. */
const A2UI_EXTENSION = 'https://a2ui.org/a2a-extension/a2ui/v1.0';

/** The shortest time between two looks at a task that is being followed. */
const FOLLOW_ROUND_MS = 750;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** What a surface tells the session about itself. */
export interface SessionOptions {
  /** A2UI catalog ids the surface's renderer can draw. Empty means text only. */
  readonly a2uiCatalogs?: readonly string[];
  /** Keep a task this session creates open after each response. Defaults to true. */
  readonly longRunning?: boolean;
  /**
   * Receives the spoken form of an answer, piece by piece, as it arrives. Without it the
   * session never asks for speech.
   */
  readonly onSpeech?: (chunk: SpeechChunk) => void;
}

/** A file sent with a turn: an image, a voice recording. */
export interface TurnFile {
  /** `image/png`, `audio/webm`, … */
  readonly mediaType: string;
  readonly name?: string | undefined;
  readonly data: Uint8Array;
}

/** What one turn sends. */
export interface TurnInput {
  readonly text: string;
  /** A user's action on an A2UI surface, as an A2UI message. */
  readonly a2uiAction?: unknown;
  /** Files sent with the text, each as a `raw` part. */
  readonly files?: readonly TurnFile[] | undefined;
  /** Ask for the answer to be spoken as well. Needs {@link SessionOptions.onSpeech}. */
  readonly speak?: boolean | undefined;
}

/** What the harness says it can do with voice, from its agent card. */
export interface VoiceSupport {
  /** Audio is transcribed for a model that does not accept it. */
  readonly transcription: boolean;
  /** An answer can be spoken. */
  readonly output: boolean;
}

function extensionParams(card: AgentCard, uri: string): unknown {
  return card.capabilities?.extensions.find((extension) => extension.uri === uri)?.params;
}

/** A connection from a surface to one harness, for one conversation. */
export class HarnessSession {
  /** The harness's agent card. */
  readonly card: AgentCard;
  /** The commands the harness lists, for highlighting what the user types. */
  readonly commands: readonly CommandInfo[];
  /** The Temporal Web UI of the harness, or null when it does not run on Temporal. */
  readonly dashboardUrl: string | null;
  /** What the harness is configured to do with voice. */
  readonly voice: VoiceSupport;
  readonly #client: Client;
  readonly #options: SessionOptions;
  #contextId = '';
  #counter = 0;

  private constructor(client: Client, card: AgentCard, options: SessionOptions) {
    this.#client = client;
    this.card = card;
    this.#options = options;
    const listed = SCHEMAS.commandsParams.safeParse(extensionParams(card, EXT.commands));
    this.commands = listed.success ? listed.data.commands : [];
    const durable = SCHEMAS.durableExecutionParams.safeParse(
      extensionParams(card, EXT.durableExecution),
    );
    this.dashboardUrl = durable.success ? durable.data.dashboardUrl : null;
    const voice = SCHEMAS.voiceParams.safeParse(extensionParams(card, EXT.voice));
    this.voice = voice.success ? voice.data : { transcription: false, output: false };
  }

  /**
   * Connects to a harness and reads its card. `target` is the harness's URL, or the
   * `ctx.harnessTarget` of a harness in this process — which, in a build with no
   * listener, is reached through the in-memory transport.
   */
  static async connect(
    target: string | HarnessTarget,
    options: SessionOptions = {},
  ): Promise<HarnessSession> {
    const at = typeof target === 'string' ? { type: 'http' as const, url: target } : target;
    const client =
      at.type === 'http' ? await new ClientFactory().createFromUrl(at.url) : await at.connect();
    return new HarnessSession(client, await client.getAgentCard(), options);
  }

  /**
   * Sends one turn and yields the view after every event, until the task rests. The first
   * view already shows what the user sent.
   *
   * @param view The view of the task being continued, or the empty view to start one.
   */
  async *send(input: TurnInput, view: TaskView = EMPTY_VIEW): AsyncIterable<TaskView> {
    const message = this.#message(input, isOpen(view) ? view.taskId : null);
    const files = fileItems(message.parts, message.messageId, 'user');
    let current =
      input.text === '' && files.length === 0
        ? view
        : withUserMessage(view, message.messageId, input.text, files);
    yield current;
    for await (const event of this.#stream(message)) {
      this.#hear(event);
      current = foldEvent(current, event);
      this.#contextId = current.contextId ?? this.#contextId;
      yield current;
    }
    if (current.state === 'working') {
      // The stream ended without a status: the reply was a command's, which is not part
      // of any task. The task is in the state it was in before.
      yield { ...current, state: view.state === 'working' ? 'idle' : view.state };
    }
  }

  /** Ends an open task without invoking the model, and returns its final view. */
  async complete(view: TaskView): Promise<TaskView> {
    const message: Message = {
      ...this.#message({ text: '' }, view.taskId),
      metadata: { [EXT.taskLifecycle]: { action: 'complete' } },
    };
    let current = view;
    for await (const event of this.#stream(message)) {
      current = foldEvent(current, event);
    }
    return current;
  }

  /** Cancels a task and returns its final view. */
  async cancel(view: TaskView): Promise<TaskView> {
    if (view.taskId === null) {
      return view;
    }
    const task = await this.#client.cancelTask({
      tenant: '',
      id: view.taskId,
      metadata: undefined,
    });
    return { ...view, state: viewOfTask(task).state };
  }

  /** The open tasks of this conversation — what another surface could join. */
  async openTasks(contextId: string = this.#contextId): Promise<Task[]> {
    const listed = await this.#client.listTasks({
      tenant: '',
      contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
      historyLength: 0,
    });
    return listed.tasks.filter((task) => isOpen(viewOfTask(task)));
  }

  /**
   * Follows a task this session did not start: yields its view now and after every
   * change, across turns driven from elsewhere, until the task is closed or `signal`
   * aborts. Each round starts from the stored task, so nothing between two
   * subscriptions is missed.
   */
  async *follow(taskId: string, signal: AbortSignal): AsyncIterable<TaskView> {
    let current: TaskView = EMPTY_VIEW;
    while (!signal.aborted) {
      const startedAt = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- rounds are sequential by nature
      const task = await this.#client.getTask({ tenant: '', id: taskId });
      current = foldEvent(current, { payload: { $case: 'task', value: task } });
      this.#contextId = task.contextId;
      yield current;
      if (!isOpen(current)) {
        return;
      }
      try {
        const events = this.#client.resubscribeTask({ tenant: '', id: taskId }, { signal });
        // oxlint-disable-next-line no-await-in-loop -- as above
        for await (const event of events) {
          current = foldEvent(current, event);
          yield current;
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        throw error;
      }
      // A resting task has no live stream: the subscription ends at once. Look again at
      // a human pace instead of asking the harness in a tight loop.
      const wait = FOLLOW_ROUND_MS - (Date.now() - startedAt);
      if (wait > 0) {
        // oxlint-disable-next-line no-await-in-loop -- rounds are sequential by nature
        await pause(wait, signal);
      }
    }
  }

  /** Hands a piece of a spoken answer to the surface. */
  #hear(event: StreamResponse): void {
    const { payload } = event;
    if (payload?.$case === 'artifactUpdate') {
      const chunk = speechChunk(payload.value.artifact, payload.value.lastChunk);
      if (chunk !== null) {
        this.#options.onSpeech?.(chunk);
      }
    }
  }

  /** The parts of a turn: its text, or its A2UI action, then its files. */
  #parts(input: TurnInput): Part[] {
    const blank = { metadata: undefined, filename: '' };
    const files = (input.files ?? []).map((file): Part => ({
      metadata: undefined,
      filename: file.name ?? '',
      mediaType: file.mediaType,
      // The SDK encodes whatever `Buffer.from` gives it; in a browser that is the shim's.
      content: { $case: 'raw', value: Buffer.from(file.data) },
    }));
    if (input.a2uiAction !== undefined) {
      const content = { $case: 'data', value: [input.a2uiAction] } as const;
      return [{ ...blank, content, mediaType: A2UI_MEDIA_TYPE }];
    }
    const text: Part = { ...blank, content: { $case: 'text', value: input.text }, mediaType: '' };
    return input.text === '' && files.length > 0 ? files : [text, ...files];
  }

  /** Builds a user message, carrying what this surface offers for the turn. */
  #message(input: TurnInput, taskId: string | null): Message {
    this.#counter += 1;
    const catalogs = this.#options.a2uiCatalogs ?? [];
    const metadata: Record<string, unknown> = {};
    if (catalogs.length > 0) {
      metadata['a2uiRendererCapabilities'] = { '1.0': { supportedCatalogIds: [...catalogs] } };
    }
    if (taskId === null && this.#options.longRunning !== false) {
      metadata[EXT.taskLifecycle] = { longRunning: true };
    }
    if (input.speak === true && this.#options.onSpeech !== undefined) {
      metadata[EXT.voice] = { output: true };
    }
    return {
      messageId: `${String(Date.now())}-${String(this.#counter)}-${Math.random().toString(36).slice(2, 8)}`,
      contextId: this.#contextId,
      taskId: taskId ?? '',
      role: Role.ROLE_USER,
      parts: this.#parts(input),
      metadata,
      extensions: [],
      referenceTaskIds: [],
    };
  }

  #stream(message: Message): AsyncIterable<StreamResponse> {
    const extensions = [
      EXT.taskLifecycle,
      EXT.activity,
      EXT.commands,
      EXT.durableExecution,
      EXT.voice,
    ];
    if ((this.#options.a2uiCatalogs ?? []).length > 0) {
      extensions.push(A2UI_EXTENSION);
    }
    return this.#client.sendMessageStream(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      { serviceParameters: ServiceParameters.create(withA2AExtensions(...extensions)) },
    );
  }
}
