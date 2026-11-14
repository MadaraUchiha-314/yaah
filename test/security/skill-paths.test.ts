import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { TaskState } from '@a2a-js/sdk';

import type { ToolResult } from '../../src/harness/core/types.ts';
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

const SECRET = 'TOP-SECRET-PAYROLL';

/**
 * A configured skills root holding one honest skill, beside files that are none of a
 * skill's business:
 *
 *   <scratch>/root/returns/            the skill
 *   <scratch>/root/sibling.txt         inside the root, outside the skill
 *   <scratch>/outside/secret.txt       outside the root
 *   <scratch>/outside/evil/SKILL.md    a valid skill, outside the root
 */
async function layout(): Promise<string> {
  scratch = await scratchDir('yaah-skill-paths-');
  await writeTree(scratch, {
    'root/returns/SKILL.md': skillMd('returns', 'Handles returns.', 'Body.'),
    'root/returns/references/policy.md': 'Thirty days.',
    'root/sibling.txt': SECRET,
    'outside/secret.txt': SECRET,
    'outside/evil/SKILL.md': skillMd('evil', 'Reads what it should not.', 'Evil body.'),
  });
  return join(scratch, 'root');
}

function read(harness: TestHarness, path: string): Promise<ToolResult> {
  return harness.harness.ctx.entities
    .resolve({ kind: 'tool', id: 'read_skill_file', version: null })
    .invoke(
      { name: 'returns', path },
      { taskId: 't', callId: 'c', key: 'k', signal: new AbortController().signal },
    );
}

describe('skill path containment', () => {
  /**
   * Feature: Security
   * Scenario: A skill symlinked from outside its configured root is not registered
   *   Given a configured skills root with a symbolic link to a valid skill outside it
   *   And a skill inside the root whose SKILL.md is a link to a file outside it
   *   When the harness starts
   *   Then neither is registered, neither is shown to the model, and the log says why
   *   And the honest skill beside them is registered
   * Requirement: docs/specs/issue-3/requirements.md Security considerations, abuse case 11
   */
  test('A skill symlinked from outside its configured root is not registered', async () => {
    const root = await layout();
    const log = join(scratch, 'yaah.log');
    await symlink(join(scratch, 'outside', 'evil'), join(root, 'evil'));
    await writeTree(root, { 'sneaky/notes.md': '' });
    await symlink(join(scratch, 'outside', 'evil', 'SKILL.md'), join(root, 'sneaky', 'SKILL.md'));
    running = await startHarness({
      config: `${skillsConfig(root)}\n[o11y]\nlog_level = "warn"\nlog_file = ${JSON.stringify(log)}`,
      turns: [callTools(call('c1', 'load_skill', { name: 'evil' })), say('No such skill.')],
    });
    const { entities } = running.harness.ctx;
    expect(entities.list('skill').map((skill) => skill.name)).toEqual(['returns']);

    const turn = await running.send('load the evil skill');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const everything = JSON.stringify(running.llm.requests);
    expect(everything).not.toContain('Evil body');
    expect(everything).not.toContain('Reads what it should not');
    expect(everything).toContain('No skill is named');

    const refusals = (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('skills/refused'));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain(join(root, 'evil'));
    expect(refusals[0]).toContain('"rule":"path.escape"');
    expect(refusals[1]).toContain(join(root, 'sneaky'));
    expect(refusals[1]).toContain('"rule":"path.escape"');
  });

  /**
   * Feature: Security
   * Scenario: read_skill_file cannot leave the skill's directory
   *   Given a registered skill
   *   When read_skill_file is asked for "../sibling.txt", for a deeper "../" path, for an
   *        absolute path, and for a symbolic link inside the skill that points outside it
   *   Then each is refused with path.escape and no byte of the target is returned
   *   And the refusal does not reveal where the skill lives on disk
   *   And a file of the skill is still readable
   * Requirement: docs/specs/issue-3/requirements.md Security considerations, abuse case 11
   */
  test('read_skill_file cannot leave the skill directory', async () => {
    const root = await layout();
    await symlink(
      join(scratch, 'outside', 'secret.txt'),
      join(root, 'returns', 'references', 'link.txt'),
    );
    await symlink(join(scratch, 'outside'), join(root, 'returns', 'assets'));
    running = await startHarness({ config: skillsConfig(root) });
    const harness = running;

    const attempts = [
      '../sibling.txt',
      '../../outside/secret.txt',
      'references/../../sibling.txt',
      join(scratch, 'outside', 'secret.txt'),
      join(root, 'returns', 'references', 'policy.md'),
      'references/link.txt',
      'assets/secret.txt',
    ];
    const results = await Promise.all(attempts.map((path) => read(harness, path)));
    for (const [index, result] of results.entries()) {
      expect([attempts[index], result.ok ? 'read' : result.error.code]).toEqual([
        attempts[index],
        'path.escape',
      ]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    const relative = results.slice(0, 3).map((result) => JSON.stringify(result));
    expect(relative.join('')).not.toContain(scratch);

    expect(await read(harness, 'references/policy.md')).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'Thirty days.' }],
    });
  });

  /**
   * Feature: Security
   * Scenario: A refused path reaches the model as a tool result and the task continues
   *   Given a registered skill
   *   When the model calls read_skill_file with "../sibling.txt"
   *   Then the call's result is a path.escape error, the file's content is in no request,
   *        and the task completes
   * Requirement: docs/specs/issue-3/requirements.md Security considerations, abuse case 11
   */
  test('A refused path reaches the model as a tool result and the task continues', async () => {
    const root = await layout();
    running = await startHarness({
      config: skillsConfig(root),
      turns: [
        callTools(call('c1', 'read_skill_file', { name: 'returns', path: '../sibling.txt' })),
        say('I cannot read that.'),
      ],
    });
    const turn = await running.send('read the sibling file');
    expect(turn.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const second = JSON.stringify(running.llm.requests[1]);
    expect(second).toContain('path.escape');
    expect(JSON.stringify(running.llm.requests)).not.toContain(SECRET);
  });
});
