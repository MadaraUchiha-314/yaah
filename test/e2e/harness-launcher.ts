/**
 * A real harness for the browser tests: the server composition on a free loopback port,
 * a scripted model, and the web UI served from `dist/web`. Prints `READY <url>` when up.
 * Started by `test/e2e/global-setup.ts`; run by Bun.
 *
 * The model has no memory of its own: what it says depends only on the request it is
 * shown, so every test — and every retry — gets the same conversation.
 */
import type { TurnExtension } from '../../src/harness/core/steps.ts';
import type { LlmEvent, LlmRequest } from '../../src/harness/models/llm/types.ts';
import { defineTool, textResult } from '../../src/harness/tools/types.ts';
import { parseConfig } from '../../src/kernel/config.ts';
import { createHarness } from '../../src/kernel/harness.ts';
import { registerEntity } from '../../src/kernel/registry.ts';
import * as webUi from '../../src/surface/renderer/web/server.ts';
import { ScriptedLlm, call, callTools, say } from '../../src/testing/scripted-llm.ts';
import {
  ScriptedSpeechToText,
  ScriptedTextToSpeech,
  silencePerWord,
} from '../../src/testing/scripted-speech.ts';
import { solidPng } from '../support/png.ts';

const A2UI_MEDIA_TYPE = 'application/a2ui+json';
const BASIC = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** A basic-catalog form, in the A2UI Express notation the model writes. */
const FORM = [
  'I need two details to file the refund.',
  '<a2ui>',
  '$/form/note = ""',
  '$/form/photo = false',
  'root = Column([Text("Refund details"), TextField("What happened?", $/form/note), CheckBox("I can send a photo of the damage", $/form/photo), Button(Text("Submit refund"), "primary", Event("submitRefund", {note: $/form/note, photo: $/form/photo}))])',
  '</a2ui>',
].join('\n');

/** The word that {@link hostileExtension} replaces with a surface no validator has seen. */
const HOSTILE_MARKER = '[[hostile-surface]]';

/** What a compromised agent might send: a component the catalog does not have, a script URL. */
const HOSTILE_SURFACE = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'hostile',
      catalogId: BASIC,
      components: [
        { id: 'root', component: 'ScriptTag', code: 'window.__pwned = true' },
        { id: 'img', component: 'Image', url: 'javascript:window.__pwned=true' },
      ],
    },
  },
];

/**
 * Stands in for an agent that bypasses the harness's own A2UI validation: it turns the
 * marker into an A2UI part exactly as written above, so the browser is the last defence.
 */
const hostileExtension: TurnExtension = {
  promptSection: '',
  openReply: () => ({
    feed: (chunk: string) => {
      if (!chunk.includes(HOSTILE_MARKER)) {
        return [{ type: 'text', text: chunk }];
      }
      const [before = '', after = ''] = chunk.split(HOSTILE_MARKER);
      return [
        { type: 'text', text: before },
        { type: 'data', mediaType: A2UI_MEDIA_TYPE, data: HOSTILE_SURFACE },
        { type: 'text', text: after },
      ];
    },
    close: () => [],
  }),
};

const tool = (id: string, ok: boolean) =>
  defineTool({
    id,
    description: id,
    inputSchema: { type: 'object' },
    retrySafe: true,
    invoke: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      if (!ok) {
        throw new Error(`${id} is unavailable`);
      }
      return textResult(`${id} finished`);
    },
  });

/** What the scripted speech-to-text model hears in every recording. */
const HEARD = 'Where is my order, asked by voice?';

/** A tool that makes a picture: an orange square, delivered as an artifact. */
const makeImage = defineTool({
  id: 'make_image',
  description: 'make_image',
  inputSchema: { type: 'object' },
  invoke: () =>
    Promise.resolve({
      ok: true,
      content: [{ type: 'text', text: 'The image was delivered.' }],
      artifacts: [
        {
          type: 'file',
          mediaType: 'image/png',
          name: 'lamp.png',
          source: { kind: 'base64', data: solidPng(96, [230, 120, 40]).toString('base64') },
        },
      ],
    }),
});

function respond(request: LlmRequest): readonly LlmEvent[] {
  const last = request.messages.at(-1);
  const shown = JSON.stringify(last);
  if (
    last?.content.some((block) => block.type === 'tool-result') === true &&
    shown.includes('The image was delivered')
  ) {
    return say('Here is the lamp you asked for.');
  }
  if (last?.content.some((block) => block.type === 'file') === true) {
    return say('I can see the image you attached.');
  }
  if (shown.includes('asked by voice')) {
    return say('I heard you. It ships today. The carrier collects at four.');
  }
  if (shown.includes('draw a lamp')) {
    return callTools(call('i1', 'make_image'));
  }
  if (last?.content.some((block) => block.type === 'tool-result') === true) {
    return shown.includes('lookup_order')
      ? say('I found the order: a ceramic lamp, delivered on 9 November.')
      : say('Thanks. A supervisor will approve the refund.');
  }
  if (shown.includes('submitRefund')) {
    return say('The refund is filed. Anything else?');
  }
  if (shown.includes('hostile')) {
    return say(`Before the surface. ${HOSTILE_MARKER} After the surface.`);
  }
  if (shown.includes('refund form')) {
    return say(FORM);
  }
  if (shown.includes('ask me')) {
    return callTools(call('q1', 'ask_user', { question: 'Refund or store credit?' }));
  }
  if (shown.includes('look up')) {
    return callTools(call('c1', 'lookup_order'), call('c2', 'refund_rules'));
  }
  return say(
    'It ships today. The carrier collects at four in the afternoon, and it should reach you within three working days.',
  );
}

const config = parseConfig(
  [
    'composition = "server"',
    'data_dir = ":memory:"',
    'model = { llm = "scripted/model", effort = "medium" }',
    '[server]\nport = 0',
    '[limits]\nmax_open_tasks_per_caller = 1000\nmax_requests_per_minute = 100000',
    // Small enough that a test can exceed it, large enough for every other attachment.
    'max_part_bytes = 300000',
    '[speech]\nstt = "scripted/stt"\ntts = "scripted/tts"',
  ].join('\n'),
  'e2e.toml',
);

const llm = new ScriptedLlm(
  Array.from({ length: 5000 }, () => respond),
  { delayMs: 25, capabilities: { input: ['image'] } },
);

const harness = await createHarness({
  config,
  setup: async (ctx) => {
    registerEntity(ctx, llm);
    // How many model calls were shown `containing`: the test that a command never
    // reaches the model asks for a word only it has typed.
    ctx.http.app.get('/__e2e/model-calls', (request, response) => {
      const asked = request.query['containing'];
      const containing = typeof asked === 'string' ? asked : '';
      const seen = llm.requests.filter((call_) => JSON.stringify(call_).includes(containing));
      response.json({ count: seen.length });
    });
    registerEntity(ctx, makeImage);
    registerEntity(ctx, new ScriptedSpeechToText([HEARD]));
    // A tenth of a second of silence per word, a few milliseconds apart.
    registerEntity(ctx, new ScriptedTextToSpeech([silencePerWord(4800)], { delayMs: 15 }));
    registerEntity(ctx, tool('lookup_order', true));
    registerEntity(ctx, tool('refund_rules', false));
    ctx.taskRuntime.addTurnExtension(() => hostileExtension);
    ctx.on('web-ui/missing', (searched) => {
      console.error(
        `The web UI is not built (looked in ${searched.join(', ')}). Run: bun run build:web`,
      );
      process.exit(1);
    });
    await ctx.use(webUi, {});
  },
});
process.stdout.write(`READY ${harness.ctx.http.url}\n`);
