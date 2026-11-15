import { TaskState } from '@a2a-js/sdk';
import { afterEach, describe, expect, test } from 'bun:test';

import type { HarnessTarget } from '../../src/app/harness-target.ts';
import { IN_MEMORY_PROTOCOL, InMemoryTransport } from '../../src/browser/in-memory-transport.ts';
import { IN_MEMORY_URL } from '../../src/browser/plugins/target.ts';
import type { Tool } from '../../src/harness/tools/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { HarnessSession } from '../../src/surface/session.ts';
import type { TaskView } from '../../src/surface/view.ts';
import { EMPTY_VIEW } from '../../src/surface/view.ts';
import type { ScriptedLlm, ScriptedTurn } from '../../src/testing/scripted-llm.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import { startBrowserHarness } from '../support/browser-harness.ts';
import { startHarness } from '../support/harness.ts';

/** A harness under test, however it is reached. */
interface Running {
  readonly target: HarnessTarget;
  readonly llm: ScriptedLlm;
  stop(): Promise<void>;
}

interface Script {
  readonly turns: readonly ScriptedTurn[];
  readonly tools?: readonly Tool[];
  readonly llmDelayMs?: number;
}

/** The two ways a surface reaches a harness: over HTTP, and in memory with no listener. */
const TARGETS: Readonly<Record<string, (script: Script) => Promise<Running>>> = {
  'over HTTP (server composition)': async (script) => {
    const started = await startHarness(script);
    return {
      target: { type: 'http', url: started.url },
      llm: started.llm,
      stop: () => started.stop(),
    };
  },
  'in memory (browser composition)': (script) => startBrowserHarness(script),
};

let running: Running | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function last(views: AsyncIterable<TaskView>): Promise<{ final: TaskView; all: TaskView[] }> {
  const all: TaskView[] = [];
  for await (const view of views) {
    all.push(view);
  }
  const final = all.at(-1);
  if (final === undefined) {
    throw new Error('no view was produced');
  }
  return { final, all };
}

/** The error `work` rejects with, as text; empty when it resolves. */
async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

const shape = (view: TaskView): string[] =>
  view.items.map((item) => `${item.kind}:${'text' in item ? item.text : item.name}`);

const lookup = defineTool({
  id: 'lookup',
  description: 'Look an order up.',
  inputSchema: { type: 'object' },
  retrySafe: true,
  invoke: () => Promise.resolve(textResult('order found')),
});

function scenarios(how: string, start: (script: Script) => Promise<Running>): void {
  describe(`harness session ${how}`, () => {
    /**
     * Feature: Browser build
     * Scenario: A surface sees a turn as a growing transcript, whatever the transport
     *   Given a surface connected to a harness over HTTP, or in memory with no listener
     *   When the user sends a message that makes the agent call a tool and then answer
     *   Then the views show the user message at once, the tool starting and finishing,
     *        the answer streaming and then settled, and the task waiting for the next message
     * Requirement: docs/specs/issue-3/requirements.md R25.1, R25.2, R19.2
     */
    test('A surface sees a turn as a growing transcript', async () => {
      running = await start({
        tools: [lookup],
        turns: [callTools(call('c1', 'lookup')), say('Your order is on its way.')],
      });
      const session = await HarnessSession.connect(running.target);
      const { final, all } = await last(session.send({ text: 'Where is my order?' }));
      expect(shape(all[0] ?? EMPTY_VIEW)).toEqual(['user:Where is my order?']);
      expect(shape(final)).toEqual([
        'user:Where is my order?',
        'tool:lookup',
        'agent:Your order is on its way.',
      ]);
      const tool = final.items.find((item) => item.kind === 'tool');
      expect(tool?.kind === 'tool' ? [tool.done, tool.ok] : []).toEqual([true, true]);
      expect(
        all.some((view) => view.items.some((item) => item.kind === 'agent' && item.streaming)),
      ).toBe(true);
      expect(final.state).toBe('awaiting-next-interaction');
    });

    /**
     * Feature: Browser build
     * Scenario: A multi-turn task is asked for input, completed and cancelled, whatever the transport
     *   Given a surface with an open long-running task
     *   When the agent asks a question, the user answers, and the user completes the task
     *   Then the task stays one task across the turns and ends completed
     *   And a second task can be cancelled
     * Requirement: docs/specs/issue-3/requirements.md R25.2, R14.3, R14.5, R14.6
     */
    test('A surface continues, is asked for input, completes and cancels', async () => {
      running = await start({
        turns: [
          callTools(call('c1', 'ask_user', { question: 'Refund or credit?' })),
          say('Refund filed.'),
          say('Second task.'),
        ],
      });
      const session = await HarnessSession.connect(running.target);
      const asked = (await last(session.send({ text: 'Help' }))).final;
      expect(asked.state).toBe('awaiting-user-input');
      expect(shape(asked)).toEqual(['user:Help', 'ask:Refund or credit?']);

      const answered = (await last(session.send({ text: 'Refund' }, asked))).final;
      expect(shape(answered).at(-1)).toBe('agent:Refund filed.');
      expect(answered.taskId).toBe(asked.taskId);

      const completed = await session.complete(answered);
      expect(completed.state).toBe('completed');
      expect(running.llm.requests.length).toBe(2);

      const second = (await last(session.send({ text: 'Another' }, completed))).final;
      expect(second.taskId).not.toBe(asked.taskId);
      expect((await session.cancel(second)).state).toBe('canceled');
    });

    /**
     * Feature: Browser build
     * Scenario: Commands and a second surface work, whatever the transport
     *   Given a task opened from one session
     *   When the session sends /model, and a second session follows the task across a turn
     *   Then the command's reply is a note, and the follower sees both answers and stops when aborted
     * Requirement: docs/specs/issue-3/requirements.md R25.2, R19.3, R23.1
     */
    test('Commands answer and a second surface follows the task', async () => {
      running = await start({
        turns: [say('First answer.'), say('Second answer.')],
        llmDelayMs: 5,
      });
      const first = await HarnessSession.connect(running.target);
      expect(first.commands.map((command) => command.name)).toContain('model');
      const note = (await last(first.send({ text: '/model' }))).final;
      expect([note.taskId, note.items.at(-1)?.kind]).toEqual([null, 'note']);

      const opened = (await last(first.send({ text: 'One' }))).final;
      const second = await HarnessSession.connect(running.target);
      const [joinable] = await second.openTasks(opened.contextId ?? '');
      expect(joinable?.id).toBe(opened.taskId ?? '');
      const stop = new AbortController();
      const seen: TaskView[] = [];
      const following = (async () => {
        for await (const view of second.follow(joinable?.id ?? '', stop.signal)) {
          seen.push(view);
          if (shape(view).includes('agent:Second answer.')) {
            stop.abort();
          }
        }
      })();
      while (seen.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- waiting for the follower's snapshot
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      await last(first.send({ text: 'Two' }, opened));
      await following;
      expect(
        shape(seen.at(-1) ?? EMPTY_VIEW).filter((entry) => entry.startsWith('agent:')),
      ).toEqual(['agent:First answer.', 'agent:Second answer.']);
    });

    /**
     * Feature: Browser build
     * Scenario: The harness calls itself as a sub-agent, whatever the transport
     *   Given a harness whose model delegates to the `self` agent
     *   When the user sends a message
     *   Then the copy answers through the harness's own A2A target and the answer comes back
     * Requirement: docs/specs/issue-3/requirements.md R25.1, R11.4
     */
    test('The self sub-agent reaches the harness through its own target', async () => {
      running = await start({
        turns: [
          callTools(call('a1', 'invoke_agent', { agent: 'self', message: 'Count the lamps.' })),
          say('There are three lamps.'),
          say('The copy counted three lamps.'),
        ],
      });
      const session = await HarnessSession.connect(running.target);
      const { final } = await last(session.send({ text: 'How many lamps?' }));
      expect(shape(final).at(-1)).toBe('agent:The copy counted three lamps.');
      expect(JSON.stringify(running.llm.requests[1]?.messages)).toContain('Count the lamps.');
      expect(JSON.stringify(running.llm.requests[2]?.messages)).toContain('three lamps');
    });
  });
}

for (const [how, start] of Object.entries(TARGETS)) {
  scenarios(how, start);
}

describe('credentials given to the page', () => {
  /**
   * Feature: Browser build
   * Scenario: Speech and image models register from the credentials the page gives
   *   Given the browser composition, whose process environment holds no OpenAI key
   *   And a configuration whose speech.stt and speech.tts name the OpenAI models
   *   When the harness is created with the key among the page's credentials
   *   Then it starts, and the speech-to-text, text-to-speech and generate_image entities
   *        are registered
   * Requirement: docs/specs/issue-3/requirements.md R25.1, R24.2, R24.3
   */
  test('Speech and image models register from page credentials', async () => {
    const variable = 'YAAH_TEST_PAGE_OPENAI_KEY';
    expect(process.env[variable]).toBeUndefined();
    const browser = await startBrowserHarness({
      config: [
        `[providers.openai]\napi_key_env = "${variable}"`,
        '[speech]\nstt = "openai/gpt-transcribe"\ntts = "openai/gpt-realtime-2.1-mini"',
      ].join('\n'),
      credentials: { [variable]: 'sk-page-secret-0008' },
    });
    running = browser;
    const { entities } = browser.harness.ctx;
    expect(entities.list('speech-to-text').map((entity) => entity.ref.id)).toEqual([
      'openai/gpt-transcribe',
    ]);
    expect(entities.list('text-to-speech').map((entity) => entity.ref.id)).toEqual([
      'openai/gpt-realtime-2.1-mini',
    ]);
    expect(entities.list('tool').map((entity) => entity.ref.id)).toContain('generate_image');
  });
});

describe('in-memory transport', () => {
  /**
   * Feature: Browser build
   * Scenario: The in-memory target is the SDK client on the harness's own request handler
   *   Given the browser composition running with no listener
   *   When a client is opened on its target
   *   Then the card names no network address, the calls are answered by the handler,
   *        and what the client is given is a copy, not the handler's own objects
   * Requirement: docs/specs/issue-3/requirements.md R25.1, R25.2
   */
  test('The in-memory target is the SDK client on the request handler', async () => {
    const browser = await startBrowserHarness({ turns: [say('Hello there.')] });
    running = browser;
    expect('http' in browser.harness.ctx).toBe(false);
    if (browser.target.type !== 'in-memory') {
      throw new Error('expected the in-memory target');
    }
    expect((await browser.target.handler.getAgentCard()).name).not.toBe('');
    const client = await browser.target.connect();
    expect(client.transport).toBeInstanceOf(InMemoryTransport);
    expect([client.transport.protocolName, client.protocolVersion]).toEqual([
      IN_MEMORY_PROTOCOL,
      '1.0',
    ]);
    const card = await client.getAgentCard();
    expect(card.supportedInterfaces.every((entry) => entry.url.startsWith(IN_MEMORY_URL))).toBe(
      true,
    );
    const session = await HarnessSession.connect(browser.target);
    const { final } = await last(session.send({ text: 'Hi' }));
    const id = final.taskId ?? '';
    const read = await client.getTask({ tenant: '', id });
    const again = await client.getTask({ tenant: '', id });
    expect(read).toEqual(again);
    expect(read).not.toBe(again);
    const listed = await client.listTasks({
      tenant: '',
      contextId: final.contextId ?? '',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
      historyLength: 0,
    });
    expect(listed.tasks.map((task) => task.id)).toEqual([id]);
    const stopped = new AbortController();
    stopped.abort(new Error('stopped before it began'));
    const refused = client.resubscribeTask({ tenant: '', id }, { signal: stopped.signal });
    expect(await rejection(refused.next())).toBe('stopped before it began');
    expect(await rejection(client.getTask({ tenant: '', id: 'no-such-task' }))).not.toBe('');
  });
});
