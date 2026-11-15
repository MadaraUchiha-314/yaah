import { describe, expect, test } from 'bun:test';

import type { Answer } from '../../src/harness/models/system-one/types.ts';
import { SystemOneError } from '../../src/harness/models/system-one/types.ts';
import { ScriptedSystemOne, answerAll } from '../../src/testing/scripted-system-one.ts';
import {
  SYSTEM_ONE_CONTRACT_QUESTIONS,
  systemOneContract,
} from '../../src/testing/system-one-contract.ts';

const ID = 'scripted/system-one';
const live = (): AbortSignal => new AbortController().signal;

systemOneContract({ describe, expect, test }, 'scripted', {
  answers: () => new ScriptedSystemOne([answerAll(0.9)]),
  retryableError: () =>
    new ScriptedSystemOne([{ error: new SystemOneError('scripted', ID, true, 'rate limited') }]),
  fatalError: () =>
    new ScriptedSystemOne([{ error: new SystemOneError('scripted', ID, false, 'bad request') }]),
});

describe('ScriptedSystemOne', () => {
  test('records every call and repeats the last decision of the script', async () => {
    const fixed: readonly Answer[] = [{ type: 'predicate', id: 'q', probability: 0.2 }];
    const model = new ScriptedSystemOne([fixed, answerAll(1)], { id: 'mine' });
    const question = { type: 'predicate' as const, id: 'q', text: 'Is it?' };
    expect(await model.decide({ text: 'one' }, [question], live())).toEqual(fixed);
    const expected: readonly Answer[] = [{ type: 'predicate', id: 'q', probability: 1 }];
    expect(await model.decide({ text: 'two' }, [question], live())).toEqual(expected);
    expect(await model.decide({ text: 'three' }, [question], live())).toEqual(expected);
    expect(model.ref).toEqual({ kind: 'system-one', id: 'mine', version: null });
    expect(model.calls.map((call) => call.input.text)).toEqual(['one', 'two', 'three']);
    expect(model.calls[0]?.questions).toEqual([question]);
  });

  test('answerAll picks the first choice and the lowest level', () => {
    expect(answerAll(0.5)({ text: '' }, SYSTEM_ONE_CONTRACT_QUESTIONS)).toEqual([
      { type: 'predicate', id: 'damaged', probability: 0.5 },
      { type: 'choice', id: 'topic', choice: 'billing', confidence: 1 },
      { type: 'score', id: 'severity', score: 0, confidence: 1 },
    ]);
  });

  test('fails clearly when the script is empty', async () => {
    const model = new ScriptedSystemOne([]);
    const outcome = await model.decide({ text: '' }, [], live()).catch((error: unknown) => error);
    expect(outcome instanceof SystemOneError && outcome.message).toBe('the script is empty');
  });

  test('an abort while it waits rejects the call', async () => {
    const model = new ScriptedSystemOne([answerAll(1)], { delayMs: 5000 });
    const controller = new AbortController();
    const pending = model.decide({ text: '' }, [], controller.signal).catch((e: unknown) => e);
    controller.abort();
    const outcome = await pending;
    expect(outcome instanceof SystemOneError && outcome.message).toBe('aborted');
  });
});
