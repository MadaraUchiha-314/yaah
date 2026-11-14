import { describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import type { Answer } from '../../harness/models/system-one/types.ts';
import { definePrompt } from '../../harness/system-prompt/index.ts';
import { parseConfig } from '../../kernel/config.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import type { ScriptedDecision } from '../../testing/scripted-system-one.ts';
import { ScriptedSystemOne, answerAll } from '../../testing/scripted-system-one.ts';
import type { TriageOptions, TriageOutcome } from './triage.ts';
import { TRIAGE_PROMPT, createTriage } from './triage.ts';

const MODEL = 'scripted/system-one';

interface Fixture {
  readonly triage: ReturnType<typeof createTriage>;
  readonly registry: EntityRegistry;
  readonly outcomes: TriageOutcome[];
}

function fixture(options: TriageOptions = {}): Fixture {
  const ctx = new Context();
  const registry = new EntityRegistry();
  ctx.provide('entities', registry);
  ctx.provide(
    'config',
    parseConfig(`[inbox]\ntriage = "system-one"\ntriage_model = "${MODEL}"`, 'test.toml'),
  );
  registry.register(definePrompt({ id: TRIAGE_PROMPT, template: 'Does it interrupt?' }));
  const outcomes: TriageOutcome[] = [];
  ctx.on('inbox/triaged', (taskId: string, itemId: string, outcome: TriageOutcome) => {
    expect([taskId, itemId]).toEqual(['t1', 't1:m1']);
    outcomes.push(outcome);
  });
  return { triage: createTriage(ctx, options), registry, outcomes };
}

function scripted(decisions: readonly ScriptedDecision[], delayMs = 0): ScriptedSystemOne {
  return new ScriptedSystemOne(decisions, { id: MODEL, delayMs });
}

describe('inbox triage', () => {
  test('asks the prompt as one predicate and interrupts from a probability of one half', async () => {
    const { triage, registry, outcomes } = fixture();
    const model = scripted([answerAll(0.5), answerAll(0.49)]);
    registry.register(model);
    expect(await triage('t1', 't1:m1', 'Stop')).toBe(true);
    expect(await triage('t1', 't1:m1', 'Thanks')).toBe(false);
    expect(model.calls[0]).toEqual({
      input: { text: 'Stop' },
      questions: [{ type: 'predicate', id: 'interrupts', text: 'Does it interrupt?' }],
    });
    expect(outcomes).toEqual([
      { model: MODEL, interrupt: true, probability: 0.5, error: null },
      { model: MODEL, interrupt: false, probability: 0.49, error: null },
    ]);
  });

  test('a message without text is not classified', async () => {
    const { triage, registry, outcomes } = fixture();
    const model = scripted([answerAll(1)]);
    registry.register(model);
    expect(await triage('t1', 't1:m1', '  \n')).toBe(false);
    expect(model.calls.length).toBe(0);
    expect(outcomes).toEqual([]);
  });

  test('no answer in time does not interrupt, and the call is aborted', async () => {
    const { triage, registry, outcomes } = fixture({ timeoutMs: 20 });
    registry.register(scripted([answerAll(1)], 5000));
    const startedAt = performance.now();
    expect(await triage('t1', 't1:m1', 'Stop')).toBe(false);
    expect(performance.now() - startedAt < 1000).toBe(true);
    expect(outcomes).toEqual([
      {
        model: MODEL,
        interrupt: false,
        probability: null,
        error: 'The triage model did not answer in time.',
      },
    ]);
  });

  test('a refusal, or no answer at all, does not interrupt', async () => {
    const { triage, registry, outcomes } = fixture();
    const refusal: readonly Answer[] = [{ type: 'refusal', id: 'interrupts', reason: 'declined' }];
    registry.register(scripted([refusal, []]));
    expect(await triage('t1', 't1:m1', 'Stop')).toBe(false);
    expect(await triage('t1', 't1:m1', 'Stop')).toBe(false);
    expect(outcomes.map((outcome) => outcome.error)).toEqual([
      'The triage model gave no decision.',
      'The triage model gave no decision.',
    ]);
  });

  test('a model that is not registered does not interrupt', async () => {
    const { triage, outcomes } = fixture();
    expect(await triage('t1', 't1:m1', 'Stop')).toBe(false);
    expect(outcomes[0]?.interrupt).toBe(false);
    expect(outcomes[0]?.error).toContain(MODEL);
  });
});
