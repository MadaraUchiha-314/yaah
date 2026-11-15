import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskState } from '@a2a-js/sdk';

import type { ToolResult } from '../../src/harness/core/types.ts';
import type { LlmRequest } from '../../src/harness/models/llm/types.ts';
import { loadAgentPlugin } from '../../src/harness/plugins/index.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { PolicyServer } from '../fixtures/mcp/policy-server.ts';
import { servePolicy } from '../fixtures/mcp/policy-server.ts';
import type { StubHttp } from '../fixtures/mcp/stub-http.ts';
import { freePort, serveStubHttp } from '../fixtures/mcp/stub-http.ts';
import { REFUND_LOG_ENV } from '../fixtures/mcp/stub-tools.ts';
import {
  MCP_SCHEMA,
  PLUGIN_SCHEMA,
  YAAH_DIR,
  pluginsConfig,
  writePlugin,
} from '../support/agent-plugin.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import { scratchDir, skillMd } from '../support/skills.ts';

const STUB = fileURLToPath(new URL('../fixtures/mcp/stub-server.ts', import.meta.url));

let running: TestHarness | undefined = undefined;
let crm: StubHttp | undefined = undefined;
let policy: PolicyServer | undefined = undefined;
let scratch = '';

afterEach(async () => {
  await running?.stop();
  await crm?.close();
  await policy?.close();
  running = undefined;
  crm = undefined;
  policy = undefined;
  delete process.env[REFUND_LOG_ENV];
  await rm(scratch, { recursive: true, force: true });
});

const http = (url: string): { type: string; url: string } => ({ type: 'streamable-http', url });

function toolResults(request: LlmRequest | undefined): ToolResult[] {
  return (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool-result' ? [block.result] : [])),
  );
}

async function refusal(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

function ids(harness: TestHarness, kind: 'tool' | 'skill' | 'command'): string[] {
  return harness.harness.ctx.entities.list(kind).map((entity) => entity.ref.id);
}

function lastUserText(request: LlmRequest | undefined): string {
  const message = (request?.messages ?? []).findLast((entry) => entry.role === 'user');
  return (message?.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

async function logLines(path: string, event: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.includes(event));
}

describe('agent plugins', () => {
  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: An agent plugin registers its skills and MCP servers
   *   Given a directory conforming to the Agent Plugins specification 1.0.0, with a skill
   *         under skills/, and an mcp.json naming a Streamable HTTP server and a stdio server
   *   When the harness starts with that directory in its configuration
   *   Then the skill is registered and its name and description are shown to the model
   *   And the tools of both servers are registered as mcp__<server>__<tool>
   *   And the stdio server runs in the plugin's root with PLUGIN_ROOT and PLUGIN_DATA set,
   *       its arguments expanded, and none of the harness's own environment
   * Requirement: docs/specs/issue-3/requirements.md R9.2
   */
  test('An agent plugin registers its skills and MCP servers', async () => {
    scratch = await scratchDir('yaah-plugin-');
    crm = await serveStubHttp(await freePort());
    process.env['YAAH_TEST_API_KEY'] = 'sk-test-secret';
    const root = await writePlugin(scratch, {
      name: 'support-kit',
      servers: {
        crm: http(crm.url),
        local: {
          type: 'stdio',
          command: basename(process.execPath),
          args: [STUB, '--root=${PLUGIN_ROOT}', '--home=${HOME}'],
          env: { STUB_CONFIG: '${PLUGIN_DATA}/config.json' },
        },
        legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
      },
      files: {
        'skills/returns/SKILL.md': skillMd(
          'returns',
          'Handles product returns.',
          'Ask for the order.',
        ),
        'skills/broken/SKILL.md': skillMd('Broken', 'Has a bad name.', ''),
      },
    });
    try {
      running = await startHarness({
        config: pluginsConfig(root),
        turns: [callTools(call('c1', 'mcp__local__dump_env')), say('Done.')],
      });
    } finally {
      delete process.env['YAAH_TEST_API_KEY'];
    }
    expect(ids(running, 'skill')).toEqual(['returns']);
    const tools = ids(running, 'tool').filter((id) => id.startsWith('mcp__'));
    for (const id of ['mcp__crm__lookup_order', 'mcp__crm__refund', 'mcp__local__dump_env']) {
      expect(tools).toContain(id);
    }
    expect(tools.some((id) => id.startsWith('mcp__legacy__'))).toBe(false);

    const turn = await running.send('What does the local server see?');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const [first, second] = running.llm.requests;
    expect(JSON.stringify(first?.messages)).toContain('- returns: Handles product returns.');
    expect(JSON.stringify(first)).not.toContain('Ask for the order.');
    const [seen] = toolResults(second);
    const names = seen?.ok === true && seen.content[0]?.type === 'text' ? seen.content[0].text : '';
    expect(names).toContain('"PLUGIN_ROOT"');
    expect(names).toContain('"PLUGIN_DATA"');
    expect(names).toContain('"STUB_CONFIG"');
    expect(names).not.toContain('YAAH_TEST_API_KEY');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A hook denies a tool call
   *   Given an agent plugin whose hooks.json runs the MCP tool "check" of its own policy
   *         server before every tool matching mcp__crm__refund*
   *   And a policy server that denies, with a reason holding a credential
   *   When the model calls mcp__crm__refund and, beside it, mcp__crm__lookup_order
   *   Then the policy server was asked about the refund only, with the event as its argument
   *   And the refund never ran
   *   And its tool result tells the model the call was denied and why, the credential redacted
   *   And the other call ran, and the task completes
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A hook denies a tool call', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const refunds = join(scratch, 'refunds.log');
    process.env[REFUND_LOG_ENV] = refunds;
    crm = await serveStubHttp(await freePort());
    policy = await servePolicy(await freePort(), () => ({
      decision: 'deny',
      reason: 'refunds need a supervisor (key sk-policy-secret-123)',
    }));
    const root = await writePlugin(scratch, {
      name: 'guarded-crm',
      servers: { crm: http(crm.url), policy: http(policy.url) },
      hooks: [
        {
          event: 'tool.before',
          match: 'mcp__crm__refund*',
          run: { type: 'mcp-tool', server: 'policy', tool: 'check' },
        },
      ],
    });
    running = await startHarness({
      config: pluginsConfig(root),
      setup: (ctx) => {
        ctx.redactor.add('sk-policy-secret-123');
      },
      turns: [
        callTools(
          call('c1', 'mcp__crm__refund', { id: 'b2' }),
          call('c2', 'mcp__crm__lookup_order', { id: 'a1' }),
        ),
        say('I could not refund the order; a supervisor has to approve it.'),
      ],
    });
    const turn = await running.send('Refund order b2.');

    expect(policy.asked).toHaveLength(1);
    expect(policy.asked[0]).toMatchObject({
      event: 'tool.before',
      tool: 'mcp__crm__refund',
      callId: 'c1',
      args: { id: 'b2' },
      taskId: turn.task?.id ?? '',
    });
    expect(existsSync(refunds)).toBe(false);

    const [denied, allowed] = toolResults(running.llm.requests[1]);
    expect(denied).toEqual({
      ok: false,
      error: {
        code: 'denied',
        message:
          'The call to mcp__crm__refund was denied by a hook and did not run: refunds need a supervisor (key [redacted])',
      },
    });
    expect(allowed?.ok).toBe(true);
    expect(JSON.stringify(running.llm.requests)).not.toContain('sk-policy-secret-123');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(turn.streamed).toContain('supervisor');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A policy that cannot be asked denies
   *   Given the same guarded plugin
   *   When the policy server answers with something that is not a decision
   *   And later stops answering at all
   *   Then each time the guarded tool does not run and the model is told why
   *   And when the policy allows, the tool runs
   * Requirement: docs/specs/issue-3/requirements.md R9.3
   */
  test('A policy that cannot be asked denies', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const refunds = join(scratch, 'refunds.log');
    process.env[REFUND_LOG_ENV] = refunds;
    crm = await serveStubHttp(await freePort());
    const answers = ['Looks fine to me!', { decision: 'allow' as const }];
    policy = await servePolicy(await freePort(), () => answers.shift() ?? 'unused');
    const root = await writePlugin(scratch, {
      name: 'guarded-crm',
      servers: { crm: http(crm.url), policy: http(policy.url) },
      hooks: [
        {
          event: 'tool.before',
          match: 'mcp__crm__refund',
          run: { type: 'mcp-tool', server: 'policy', tool: 'check' },
        },
        { event: 'tool.after', run: { type: 'mcp-tool', server: 'policy', tool: 'absent' } },
      ],
    });
    const refund = (id: string) => callTools(call(id, 'mcp__crm__refund', { id: 'b2' }));
    running = await startHarness({
      config: pluginsConfig(root),
      turns: [refund('c1'), refund('c2'), say('Refunded.')],
    });
    const first = await running.send('Refund order b2.');
    expect(first.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const [malformed] = toolResults(running.llm.requests[1]);
    expect(malformed?.ok === false ? malformed.error.code : '').toBe('denied');
    expect(malformed?.ok === false ? malformed.error.message : '').toContain(
      'gave no usable decision',
    );
    expect(toolResults(running.llm.requests[2]).at(-1)?.ok).toBe(true);
    expect(await readFile(refunds, 'utf8')).toBe('b2\n');

    await policy.close();
    policy = undefined;
    running.llm.push(refund('c3'), say('I could not refund.'));
    const second = await running.send('Refund it again.');
    expect(second.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const last = toolResults(running.llm.requests.at(-1)).at(-1);
    expect(last?.ok === false ? last.error.code : '').toBe('denied');
    expect(await readFile(refunds, 'utf8')).toBe('b2\n');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A prompt command sends its text to the model
   *   Given an agent plugin with commands/triage.md in yaah's extension directory
   *   When the user sends "/triage order 42 arrived broken"
   *   Then the command is listed among the commands
   *   And the model receives the file's text followed by the user's arguments as the
   *       user's message, and answers
   *   When the user sends "/triage" alone
   *   Then the model receives the file's text
   * Requirement: docs/specs/issue-3/requirements.md R9.2
   */
  test('A prompt command sends its text to the model', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const root = await writePlugin(scratch, {
      name: 'triage-kit',
      files: {
        [`${YAAH_DIR}/commands/triage.md`]:
          'Classify the report below as bug, question or refund.\n',
        [`${YAAH_DIR}/commands/not a command.md`]: 'Never registered.',
        [`${YAAH_DIR}/commands/model.md`]: 'Clashes with a built-in command.',
        [`${YAAH_DIR}/commands/notes.txt`]: 'Not markdown.',
      },
    });
    running = await startHarness({
      config: pluginsConfig(root),
      turns: [say('This is a refund.'), say('Send me a report.')],
    });
    expect(ids(running, 'command')).toContain('triage');
    expect(ids(running, 'command')).not.toContain('notes');

    const turn = await running.send('/triage order 42 arrived broken');
    expect(turn.reply).toBeUndefined();
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(turn.streamed).toBe('This is a refund.');
    expect(lastUserText(running.llm.requests[0])).toBe(
      'Classify the report below as bug, question or refund.\n\norder 42 arrived broken',
    );

    await running.send('/triage');
    expect(lastUserText(running.llm.requests[1])).toBe(
      'Classify the report below as bug, question or refund.',
    );
    const model = await running.send('/model');
    expect(model.reply).toBeDefined();
    expect(running.llm.requests).toHaveLength(2);
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A plugin that breaks the specification is refused and named
   *   Given three configured plugins: one whose plugin.json has an invalid name, one
   *         whose hooks.json names a server its mcp.json does not declare, and a valid one
   *   When the harness starts
   *   Then it starts and the valid plugin's skill is registered
   *   And nothing of the refused plugins is registered — no skill, no tool, no hook
   *   And the log names each refused plugin and the rule it broke
   * Requirement: docs/specs/issue-3/requirements.md R9.4
   */
  test('A plugin that breaks the specification is refused and named', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const log = join(scratch, 'yaah.log');
    crm = await serveStubHttp(await freePort());
    const skill = { 'skills/hidden/SKILL.md': skillMd('hidden', 'Must not load.', '') };
    const badName = await writePlugin(scratch, {
      name: 'bad-name',
      manifest: { $schema: PLUGIN_SCHEMA, name: 'Bad_Name' },
      servers: { crm: http(crm.url) },
      files: skill,
    });
    const strayHook = await writePlugin(scratch, {
      name: 'stray-hook',
      servers: { crm: http(crm.url) },
      hooks: [{ event: 'tool.before', run: { type: 'mcp-tool', server: 'policy', tool: 'check' } }],
      files: { 'skills/hidden-too/SKILL.md': skillMd('hidden-too', 'Must not load.', '') },
    });
    const good = await writePlugin(scratch, {
      name: 'good',
      manifest: { $schema: PLUGIN_SCHEMA, name: 'good', surprise: true },
      files: {
        'skills/returns/SKILL.md': skillMd('returns', 'Handles returns.', ''),
        'mcp.json': 'not json either',
      },
    });
    const missing = join(scratch, 'not-there');
    const notJson = await writePlugin(scratch, {
      name: 'not-json',
      files: { 'plugin.json': '{ "name": ' },
    });
    running = await startHarness({
      config: [
        pluginsConfig(badName, strayHook, missing, notJson, good),
        `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      ].join('\n'),
    });
    expect(ids(running, 'skill')).toEqual(['returns']);
    expect(ids(running, 'tool').filter((id) => id.startsWith('mcp__'))).toEqual([]);

    const refused = (await logLines(log, 'plugins/refused')).map((line): unknown =>
      JSON.parse(line),
    );
    expect(refused).toEqual([
      expect.objectContaining({ level: 'error', path: badName, rule: '§5.5 name: pattern' }),
      expect.objectContaining({ path: strayHook, rule: 'hooks.json run.server' }),
      expect.objectContaining({ path: missing, rule: '§4.1 plugin root' }),
      expect.objectContaining({ path: notJson, rule: '§5.1 plugin.json' }),
    ]);
    expect(JSON.stringify(refused[0])).toContain('bad-name');
    expect(JSON.stringify(refused[1])).toContain('stray-hook');
    const [notice] = await logLines(log, 'plugins/loaded');
    expect(notice).toContain('"plugin":"good"');
    expect(notice).toContain('surprise');
    expect(notice).toContain('mcp.json was not used');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A plugin is loaded from code
   *   Given a harness with no plugin in its configuration
   *   When the developer loads one from createHarness's setup — its manifest, MCP
   *        servers, hooks and commands given in memory, its skills in a directory
   *   Then the report lists what was registered and what was skipped
   *   And the hook guards the tool exactly as for a plugin read from disk
   *   And a manifest that breaks a rule is refused the same way, naming the rule
   * Requirement: docs/specs/issue-3/requirements.md R9.2, R9.4
   */
  test('A plugin is loaded from code', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const refunds = join(scratch, 'refunds.log');
    process.env[REFUND_LOG_ENV] = refunds;
    crm = await serveStubHttp(await freePort());
    policy = await servePolicy(await freePort(), () => ({ decision: 'deny', reason: 'frozen' }));
    const crmUrl = crm.url;
    const policyUrl = policy.url;
    const root = await writePlugin(scratch, {
      name: 'on-disk-part',
      files: { 'skills/returns/SKILL.md': skillMd('returns', 'Handles returns.', '') },
    });
    const reports: unknown[] = [];
    const errors: unknown[] = [];
    running = await startHarness({
      setup: async (ctx) => {
        reports.push(
          await loadAgentPlugin(ctx, {
            path: root,
            manifest: { $schema: PLUGIN_SCHEMA, name: 'in-code', version: '1.0.0' },
            mcp: {
              $schema: MCP_SCHEMA,
              mcpServers: {
                crm: http(crmUrl),
                policy: http(policyUrl),
                shell: { type: 'stdio', command: 'sh -c ls' },
              },
            },
            hooks: {
              hooks: [
                {
                  event: 'tool.before',
                  match: 'mcp__crm__refund',
                  run: { type: 'mcp-tool', server: 'policy', tool: 'check' },
                },
              ],
            },
            commands: { summarize: 'Summarize the conversation so far.' },
          }),
          await loadAgentPlugin(ctx, { manifest: { $schema: PLUGIN_SCHEMA, name: 'memory-only' } }),
        );
        for (const source of [
          { manifest: { $schema: PLUGIN_SCHEMA, name: 'UPPER' } },
          { manifest: { $schema: PLUGIN_SCHEMA, name: 'x', author: 'me' } },
          {
            manifest: { $schema: PLUGIN_SCHEMA, name: 'x' },
            hooks: { hooks: [{ event: 'tool.never' }] },
          },
          {},
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- one refusal after another
          await loadAgentPlugin(ctx, source).catch((error: unknown) => errors.push(error));
        }
      },
      turns: [callTools(call('c1', 'mcp__crm__refund', { id: 'b2' })), say('Refunds are frozen.')],
    });
    expect(reports[0]).toEqual({
      name: 'in-code',
      skills: ['returns'],
      servers: ['crm', 'policy'],
      commands: ['summarize'],
      hooks: 1,
      notices: [expect.stringContaining('"shell"')],
    });
    expect(reports[1]).toEqual({
      name: 'memory-only',
      skills: [],
      servers: [],
      commands: [],
      hooks: 0,
      notices: [],
    });
    // Read by shape, not by class: the composition loads its own copy of the module.
    const rules = errors.map((error) =>
      typeof error === 'object' && error !== null && 'rule' in error ? error.rule : error,
    );
    expect(rules).toEqual([
      '§5.5 name: pattern',
      '§5.4 author: type',
      'hooks.json hooks.0.event',
      '§5.1 plugin.json',
    ]);

    await running.send('Refund order b2.');
    const [denied] = toolResults(running.llm.requests[1]);
    expect(denied?.ok === false ? denied.error.message : '').toContain('frozen');
    expect(existsSync(refunds)).toBe(false);
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A plugin cannot reach outside its root
   *   Given a plugin whose plugin.json is a symbolic link to a file outside its root
   *   And another whose skills directory and mcp.json are such links
   *   When the harness starts
   *   Then the first is refused, naming the containment rule
   *   And the second loads without the skills and servers that lie outside it
   * Requirement: docs/specs/issue-3/requirements.md Security considerations, abuse case 11
   */
  test('A plugin cannot reach outside its root', async () => {
    scratch = await scratchDir('yaah-plugin-');
    const log = join(scratch, 'yaah.log');
    crm = await serveStubHttp(await freePort());
    const outside = await writePlugin(scratch, {
      name: 'outside',
      servers: { crm: http(crm.url) },
      files: { 'skills/stolen/SKILL.md': skillMd('stolen', 'Lies outside.', '') },
    });
    const linkedManifest = join(scratch, 'linked-manifest');
    await writePlugin(scratch, { name: 'linked-manifest', files: { 'README.md': '' } });
    await rm(join(linkedManifest, 'plugin.json'));
    await symlink(join(outside, 'plugin.json'), join(linkedManifest, 'plugin.json'));
    const linkedParts = await writePlugin(scratch, {
      name: 'linked-parts',
      files: {
        'skills-file-plugin/keep': '',
        [`${YAAH_DIR}/commands/hello.md`]: 'Say hello.',
      },
    });
    await symlink(join(outside, 'skills'), join(linkedParts, 'skills'));
    const fileSkills = await writePlugin(scratch, {
      name: 'file-skills',
      files: { skills: 'a file where a directory belongs' },
    });
    running = await startHarness({
      config: [
        pluginsConfig(linkedManifest, linkedParts, fileSkills),
        `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      ].join('\n'),
    });
    expect(ids(running, 'skill')).toEqual([]);
    expect(ids(running, 'command')).toContain('hello');
    const [refused] = await logLines(log, 'plugins/refused');
    expect(refused).toContain('§4.1 plugin.json: containment');
    const notices = (await logLines(log, 'plugins/loaded')).join('\n');
    expect(notices).toContain('"plugin":"file-skills"');
    expect(notices).toContain('§6.2');
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A plugin whose server id is already in use is refused
   *   Given a plugin "lenient" whose server "policy" always allows
   *   And a plugin "guarded-crm", loaded after it, whose own server "policy" denies refunds
   *   When the harness starts
   *   Then "guarded-crm" is refused by name, for the server id "policy"
   *   And nothing of it is registered: no hook, no tool of its other server
   *   And "lenient" is loaded as before
   *   And the MCP service refuses a second server under that id, whoever adds it
   * Requirement: docs/specs/issue-3/requirements.md R9.3; Security considerations
   *   (self-review 1, extensions #2)
   */
  test('A plugin whose server id is already in use is refused', async () => {
    scratch = await scratchDir('yaah-plugin-');
    crm = await serveStubHttp(await freePort());
    policy = await servePolicy(await freePort(), () => ({ decision: 'allow' }));
    const strict = await servePolicy(await freePort(), () => ({ decision: 'deny' }));
    const lenient = await writePlugin(scratch, {
      name: 'lenient',
      servers: { policy: http(policy.url) },
    });
    const guarded = await writePlugin(scratch, {
      name: 'guarded-crm',
      servers: { crm: http(crm.url), policy: http(strict.url) },
      hooks: [
        {
          event: 'tool.before',
          match: 'mcp__crm__refund',
          run: { type: 'mcp-tool', server: 'policy', tool: 'check' },
        },
      ],
    });
    const log = join(scratch, 'yaah.log');
    try {
      running = await startHarness({
        config: [
          pluginsConfig(lenient, guarded),
          `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
        ].join('\n'),
      });
      const refused = await logLines(log, 'plugins/refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain('"rule":"mcp.json policy: server id in use"');
      expect(refused[0]).toContain('guarded-crm');
      expect(ids(running, 'tool').filter((id) => id.startsWith('mcp__'))).toEqual([
        'mcp__policy__check',
      ]);
      const verdict = await running.harness.ctx.hooks.dispatch('tool.before', {
        taskId: 't',
        key: 'k',
        callId: 'c',
        args: {},
        tool: 'mcp__crm__refund',
      });
      expect(verdict).toEqual({ decision: 'allow' });
      expect(policy.asked).toEqual([]);
      expect(strict.asked).toEqual([]);
      // The service itself refuses the id too, whoever asks.
      const again = await refusal(
        running.harness.ctx.mcp.addServer({
          id: 'policy',
          transport: 'http',
          command: undefined,
          args: [],
          env: [],
          url: strict.url,
        }),
      );
      expect(again).toContain('already connected under the id "policy"');
    } finally {
      await strict.close();
    }
  });

  /**
   * Feature: Skills, agent plugins and hooks
   * Scenario: A plugin whose own server ids clash once normalised is refused whole
   *   Given a plugin "twin-db" whose mcp.json declares the servers "my.db" and "my_db",
   *         which would give their tools the same names
   *   And it has a hook, a skill and a command
   *   When the harness starts
   *   Then "twin-db" is refused by name, for the clash
   *   And nothing of it is registered: no tool, no skill, no command, no hook
   * Requirement: docs/specs/issue-3/requirements.md R9.3 (self-review 2, #12)
   */
  test('A plugin whose own server ids clash once normalised is refused whole', async () => {
    scratch = await scratchDir('yaah-plugin-');
    crm = await serveStubHttp(await freePort());
    const twin = await writePlugin(scratch, {
      name: 'twin-db',
      servers: { 'my.db': http(crm.url), my_db: http(crm.url) },
      hooks: [
        {
          event: 'tool.before',
          match: 'mcp__crm__refund',
          run: { type: 'mcp-tool', server: 'my.db', tool: 'check' },
        },
      ],
      files: {
        'skills/twins/SKILL.md': skillMd('twins', 'A skill of the plugin.', 'Body.'),
        [`${YAAH_DIR}/commands/twins.md`]: 'Say twins.',
      },
    });
    const log = join(scratch, 'yaah.log');
    running = await startHarness({
      config: [
        pluginsConfig(twin),
        `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      ].join('\n'),
    });
    const refused = await logLines(log, 'plugins/refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('twin-db');
    expect(refused[0]).toContain('server id clash');
    expect(ids(running, 'tool').filter((id) => id.startsWith('mcp__'))).toEqual([]);
    expect(ids(running, 'skill')).toEqual([]);
    expect(ids(running, 'command')).not.toContain('twins');
    const verdict = await running.harness.ctx.hooks.dispatch('tool.before', {
      taskId: 't',
      key: 'k',
      callId: 'c',
      args: {},
      tool: 'mcp__crm__refund',
    });
    expect(verdict).toEqual({ decision: 'allow' });
  });
});
