/**
 * A whole harness for tests: the real server composition on a loopback port, with a
 * scripted model, reached only through the official A2A SDK client — the way a surface
 * or another agent reaches it.
 */
import type { Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import type { Context } from 'cordis';

import { EXT, SCHEMAS, readExtension } from '../../src/app/api-server/extensions/index.ts';
import type { LlmCapabilities } from '../../src/harness/models/llm/types.ts';
import type { Tool } from '../../src/harness/tools/types.ts';
import type { Harness } from '../../src/kernel/bootstrap.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import type { ScriptedTurn } from '../../src/testing/scripted-llm.ts';
import { ScriptedLlm } from '../../src/testing/scripted-llm.ts';

/** Options of {@link startHarness}. */
export interface HarnessOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly tools?: readonly Tool[];
  /** Extra `config.toml` text, appended to the test defaults. */
  readonly config?: string;
  readonly llmDelayMs?: number;
  /** What the scripted model says it accepts beyond text. */
  readonly capabilities?: Partial<LlmCapabilities>;
  /** Use this data directory instead of the in-memory stores. */
  readonly dataDir?: string;
  readonly setup?: (ctx: Context) => void | Promise<void>;
  /** Reuse a scripted model, e.g. across a restart. */
  readonly llm?: ScriptedLlm;
}

/** What a message sent by a test may carry. */
export interface SendOptions {
  readonly taskId?: string;
  readonly contextId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly extensions?: readonly string[];
  readonly messageId?: string;
  /** Parts sent after the text; the text part is left out when the text is empty. */
  readonly parts?: readonly Part[];
}

/** A running harness and the client talking to it. */
export interface TestHarness {
  readonly url: string;
  readonly client: Client;
  readonly llm: ScriptedLlm;
  readonly harness: Harness;
  /** Sends a message over the streaming call and collects everything that comes back. */
  send(text: string, options?: SendOptions): Promise<Turn>;
  /** Builds a user message without sending it. */
  message(text: string, options?: SendOptions): Message;
  stop(): Promise<void>;
}

/** Everything one streaming call returned. */
export interface Turn {
  readonly events: readonly StreamResponse[];
  /** The task as last seen in the stream, with status updates applied. */
  readonly task: Task | undefined;
  /** The text of every artifact chunk, in arrival order, joined. */
  readonly streamed: string;
  /** A direct message reply, when the call produced no task. */
  readonly reply: Message | undefined;
}

let counter = 0;

function userMessage(text: string, options: SendOptions = {}): Message {
  counter += 1;
  return {
    messageId: options.messageId ?? `test-${String(counter)}-${String(Date.now())}`,
    contextId: options.contextId ?? '',
    taskId: options.taskId ?? '',
    role: Role.ROLE_USER,
    parts: [
      ...(text === '' && options.parts !== undefined
        ? []
        : [
            {
              content: { $case: 'text', value: text } as const,
              metadata: undefined,
              filename: '',
              mediaType: '',
            },
          ]),
      ...(options.parts ?? []),
    ],
    metadata: options.metadata,
    extensions: [...(options.extensions ?? [])],
    referenceTaskIds: [],
  };
}

function fold(events: readonly StreamResponse[]): Turn {
  const state: { task: Task | undefined; reply: Message | undefined; streamed: string } = {
    task: undefined,
    reply: undefined,
    streamed: '',
  };
  for (const event of events) {
    const { payload } = event;
    if (payload?.$case === 'task') {
      state.task = payload.value;
    } else if (payload?.$case === 'message') {
      state.reply = payload.value;
    } else if (payload?.$case === 'statusUpdate' && state.task !== undefined) {
      state.task = { ...state.task, status: payload.value.status };
    } else if (payload?.$case === 'artifactUpdate' && payload.value.append) {
      for (const part of payload.value.artifact?.parts ?? []) {
        state.streamed += part.content?.$case === 'text' ? part.content.value : '';
      }
    }
  }
  return { events, ...state };
}

/** Starts a harness on a free loopback port. */
export async function startHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const llm =
    options.llm ??
    new ScriptedLlm(options.turns ?? [], {
      ...(options.llmDelayMs === undefined ? {} : { delayMs: options.llmDelayMs }),
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
  const config = parseConfig(
    [
      'composition = "server"',
      `data_dir = ${JSON.stringify(options.dataDir ?? ':memory:')}`,
      `model = { llm = ${JSON.stringify(llm.ref.id)}, effort = "medium" }`,
      options.config?.includes('[server]') === true ? '' : '[server]\nport = 0',
      // Quiet by default: a test of the log asks for it.
      options.config?.includes('[o11y]') === true ? '' : '[o11y]\nlog_level = "error"',
      options.config ?? '',
      // The web chat is served only when a test adds it: `dist/web` may or may not exist.
      options.config?.includes('"web-ui"') === true
        ? ''
        : '[[overrides]]\nid = "web-ui"\ndisabled = true',
    ].join('\n'),
    'test-config.toml',
  );
  const harness = await createHarness({
    config,
    setup: async (ctx) => {
      registerEntity(ctx, llm);
      for (const tool of options.tools ?? []) {
        registerEntity(ctx, tool);
      }
      await options.setup?.(ctx);
    },
  });
  const { url } = harness.ctx.http;
  const client = await new ClientFactory().createFromUrl(url);
  return {
    url,
    client,
    llm,
    harness,
    message: userMessage,
    send: async (text, sendOptions = {}) => {
      const events: StreamResponse[] = [];
      const request = {
        tenant: '',
        message: userMessage(text, sendOptions),
        configuration: undefined,
        metadata: undefined,
      };
      const extensions = sendOptions.extensions ?? [];
      const callOptions =
        extensions.length === 0
          ? {}
          : { serviceParameters: ServiceParameters.create(withA2AExtensions(...extensions)) };
      for await (const event of client.sendMessageStream(request, callOptions)) {
        events.push(event);
      }
      return fold(events);
    },
    stop: async () => {
      await harness.dispose();
    },
  };
}

/** The text of a task's status message. */
export function statusText(task: Task | undefined): string {
  return (task?.status?.message?.parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

/** The `input-required` sub-state a task's status carries, or undefined. */
export function subStateOf(task: Task | undefined): string | undefined {
  return readExtension(
    task?.status?.message?.metadata,
    EXT.taskLifecycle,
    SCHEMAS.taskLifecycleStatus,
  )?.subState;
}
