import { describe, expect, test } from 'bun:test';

import { createCompactor } from '../../src/harness/core/context/compaction.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import { createCore } from '../support/core.ts';

const long = (label: string): string => `${label} ${'word '.repeat(120)}`;

describe('compaction', () => {
  /**
   * Feature: Context window manager and compaction
   * Scenario: An oversized conversation is compacted before the model call
   *   Given a long-running task whose conversation exceeds the model's threshold
   *   When the next turn starts
   *   Then the older turns are replaced by a summary before the model is called
   *   And the system prompt and the task are still sent in full
   *   And an event reports fewer tokens after than before
   * Requirement: docs/specs/issue-3/requirements.md R6.3, R6.4, R6.5
   */
  test('An oversized conversation is compacted before the model call', async () => {
    const reported: [number, number][] = [];
    const core = await createCore({
      task: { longRunning: true, model: { name: 'Refund', goal: 'Refund order A-1' } },
      turns: [
        say(long('answer-one')),
        say(long('answer-two')),
        say('SUMMARY OF EARLIER TURNS'),
        say('final answer'),
      ],
    });
    const compact = createCompactor({
      registry: core.registry,
      persistence: core.persistence,
      tasks: core.tasks,
      defaultLlm: core.llm.ref.id,
      keepRecentFraction: 0.2,
      onCompacted: (_task, before, after) => {
        reported.push([before, after]);
      },
    });
    // The harness was built without a compactor; install one for this test.
    Object.assign(core.handlers, { 'context.compact': compact });

    await core.send(long('question-one'));
    await core.statuses(2);
    await core.send(long('question-two'));
    await core.statuses(4);
    // Shrink the model's window so that the conversation so far sits just at the threshold:
    // the third question then pushes the next request over it.
    const measured = await core.handlers['context.build'](
      {
        taskId: core.taskId,
        key: 'probe',
        signal: new AbortController().signal,
        outcomeUnknown: false,
      },
      {},
    );
    Object.assign(core.llm.capabilities, { contextWindow: measured.estimatedTokens / 0.8 });
    await core.send('question-three');
    await core.statuses(6);

    expect(reported.length).toBe(1);
    expect((reported[0]?.[1] ?? 0) < (reported[0]?.[0] ?? 0)).toBe(true);
    const finalRequest = core.llm.requests.at(-1);
    const shown = JSON.stringify(finalRequest?.messages);
    expect(shown).toContain('SUMMARY OF EARLIER TURNS');
    expect(shown).not.toContain('question-one');
    expect(shown).toContain('question-three');
    expect(shown).toContain('Refund order A-1');
    expect(finalRequest?.messages[0]?.role).toBe('system');
    // The summarising call got the compaction instructions and the old turns.
    const summarising = JSON.stringify(core.llm.requests[2]?.messages);
    expect(summarising).toContain('Summarise the conversation');
    expect(summarising).toContain('question-one');
  });

  /**
   * Feature: Context window manager and compaction
   * Scenario: A small conversation is left alone
   *   Given a conversation well under the model's threshold
   *   When a turn runs
   *   Then no compaction happens
   * Requirement: docs/specs/issue-3/requirements.md R6.3
   */
  test('A small conversation is left alone', async () => {
    const core = await createCore({ turns: [say('Hi.')] });
    await core.send('Hello');
    await core.finished;
    expect(core.llm.requests.length).toBe(1);
    expect((await core.transcript()).includes('summary')).toBe(false);
  });
});
