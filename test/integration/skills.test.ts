import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskState } from '@a2a-js/sdk';

import type { ToolResult } from '../../src/harness/core/types.ts';
import type { LlmRequest } from '../../src/harness/models/llm/types.ts';
import { call, callTools, say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import { scratchDir, skillMd, skillsConfig, writeTree } from '../support/skills.ts';

let running: TestHarness | undefined = undefined;
let scratch = '';

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(scratch, { recursive: true, force: true });
});

const BODY = '# Handling a return\n\n1. Ask for the order number.\n2. Read references/policy.md.\n';

/** Every system message of a request, joined. */
function systemText(request: LlmRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function toolResults(request: LlmRequest | undefined): { callId: string; result: ToolResult }[] {
  return (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'tool-result' ? [{ callId: block.callId, result: block.result }] : [],
    ),
  );
}

describe('skills', () => {
  /**
   * Feature: Skills
   * Scenario: A skill body is loaded only when used
   *   Given a configured directory holding the skill "returns"
   *   When a task starts
   *   Then the first model request shows the skill's name and description, not its body
   *   When the model calls load_skill for it
   *   Then the next request holds the body, front matter removed, as that call's tool result
   *   And nowhere else
   * Requirement: docs/specs/issue-3/requirements.md R9.1
   */
  test('A skill body is loaded only when used', async () => {
    scratch = await scratchDir('yaah-skills-');
    await writeTree(scratch, {
      'returns/SKILL.md': skillMd(
        'returns',
        'Handles product returns. Use when a customer sends something back.',
        BODY,
      ),
      'returns/references/policy.md': 'Returns are accepted within 30 days.',
    });
    running = await startHarness({
      config: skillsConfig(scratch),
      turns: [
        callTools(call('c1', 'load_skill', { name: 'returns' })),
        callTools(call('c2', 'read_skill_file', { name: 'returns', path: 'references/policy.md' })),
        say('You can return it within 30 days.'),
      ],
    });
    const turn = await running.send('I want to send my order back.');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    const [first, second, third] = running.llm.requests;
    expect(systemText(first)).toContain(
      '- returns: Handles product returns. Use when a customer sends something back.',
    );
    expect(systemText(first)).toContain('load_skill');
    expect(JSON.stringify(first)).not.toContain('Ask for the order number');
    const offered = first?.tools.map((tool) => tool.name) ?? [];
    expect(offered).toContain('load_skill');
    expect(offered).toContain('read_skill_file');

    expect(toolResults(second)).toEqual([
      { callId: 'c1', result: { ok: true, content: [{ type: 'text', text: BODY }] } },
    ]);
    expect(JSON.stringify(second)).not.toContain('description: Handles');
    expect(systemText(second)).toBe(systemText(first));
    expect(toolResults(third).at(-1)).toEqual({
      callId: 'c2',
      result: {
        ok: true,
        content: [{ type: 'text', text: 'Returns are accepted within 30 days.' }],
      },
    });
  });

  /**
   * Feature: Skills
   * Scenario: A skill that breaks the specification is refused and named
   *   Given a directory with one valid skill, one whose name differs from its directory,
   *         and a second directory that does not exist
   *   When the harness starts
   *   Then it starts, the valid skill is registered and offered to the model
   *   And the log names each refused skill and the rule it broke
   * Requirement: docs/specs/issue-3/requirements.md R9.4
   */
  test('A skill that breaks the specification is refused and named', async () => {
    scratch = await scratchDir('yaah-skills-');
    const log = join(scratch, 'yaah.log');
    await writeTree(join(scratch, 'skills'), {
      'returns/SKILL.md': skillMd('returns', 'Handles returns.', BODY),
      'billing/SKILL.md': skillMd('invoices', 'Explains invoices.', 'Body.'),
    });
    const absent = join(scratch, 'absent');
    running = await startHarness({
      config: [
        skillsConfig(join(scratch, 'skills'), absent, join(scratch, 'skills')),
        `[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      ].join('\n'),
      turns: [say('Hello.')],
    });
    const names = running.harness.ctx.entities.list('skill').map((skill) => skill.name);
    expect(names).toEqual(['returns']);
    await running.send('hi');
    expect(systemText(running.llm.requests[0])).toContain('- returns: Handles returns.');
    expect(systemText(running.llm.requests[0])).not.toContain('invoices');

    const records = (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('skills/refused'))
      .map((line): unknown => JSON.parse(line));
    // The third path repeats the first: its skills are found again and refused again.
    expect(records).toEqual([
      expect.objectContaining({
        level: 'warn',
        rule: 'name.directory',
        path: join(scratch, 'skills', 'billing'),
      }),
      expect.objectContaining({ rule: 'path.missing', path: absent }),
      expect.objectContaining({ rule: 'name.directory' }),
      expect.objectContaining({
        rule: 'name.duplicate',
        path: join(scratch, 'skills', 'returns'),
      }),
    ]);
    expect(JSON.stringify(records[0])).toContain('billing');
    expect(JSON.stringify(records[0])).toContain('name.directory');
  });

  /**
   * Feature: Skills
   * Scenario: Without skills the context has no skills section
   *   Given no configured skill
   *   When a task runs
   *   Then the model request holds no skills section
   * Requirement: docs/specs/issue-3/requirements.md R9.1
   */
  test('Without skills the context has no skills section', async () => {
    scratch = await scratchDir('yaah-skills-');
    running = await startHarness({ turns: [say('Hello.')] });
    await running.send('hi');
    expect(systemText(running.llm.requests[0])).not.toContain('## Skills');
  });
});
