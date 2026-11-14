import type { Answer, Question, SystemOne } from '../harness/models/system-one/types.ts';
import { SystemOneError } from '../harness/models/system-one/types.ts';
import type { ContractApi } from './contract-api.ts';

/**
 * How a test makes an implementation produce each situation the contract checks. For a
 * real provider this is done with canned HTTP responses; no network is involved.
 */
export interface SystemOneContractSubject {
  /**
   * A model that will answer {@link SYSTEM_ONE_CONTRACT_QUESTIONS}: the predicate
   * `damaged`, the choice `topic` and the score `severity`, in that order.
   */
  answers(): SystemOne;
  /** A model whose provider fails with a rate limit or a server error. */
  retryableError(): SystemOne;
  /** A model whose provider rejects the request (bad request or authentication). */
  fatalError(): SystemOne;
}

/** The input every call of the contract judges. */
export const SYSTEM_ONE_CONTRACT_INPUT: string = 'The package arrived with a broken screen.';

/** The questions every call of the contract asks: one of each type. */
export const SYSTEM_ONE_CONTRACT_QUESTIONS: readonly Question[] = [
  { type: 'predicate', id: 'damaged', text: 'Does the customer report a damaged item?' },
  {
    type: 'choice',
    id: 'topic',
    text: 'What is the message about?',
    choices: [
      { value: 'billing' },
      { value: 'shipping', description: 'Delivery, or the state the item arrived in.' },
      { value: 'other' },
    ],
  },
  {
    type: 'score',
    id: 'severity',
    text: 'How severe is the problem?',
    levels: [{ label: 'Cosmetic' }, { label: 'Degraded' }, { label: 'Unusable' }],
  },
];

function inUnitRange(value: number): boolean {
  return value >= 0 && value <= 1;
}

/** Whether `answer` is a legal answer to `question`, by the invariants of `Answer`. */
function fits(question: Question, answer: Answer | undefined): boolean {
  if (answer === undefined || answer.id !== question.id) {
    return false;
  }
  if (answer.type === 'refusal') {
    return true;
  }
  if (answer.type === 'predicate') {
    return question.type === 'predicate' && inUnitRange(answer.probability);
  }
  if (answer.type === 'choice') {
    return (
      question.type === 'choice' &&
      inUnitRange(answer.confidence) &&
      question.choices.some((choice) => choice.value === answer.choice)
    );
  }
  return (
    question.type === 'score' &&
    inUnitRange(answer.confidence) &&
    answer.score >= 0 &&
    answer.score <= question.levels.length - 1
  );
}

async function failure(model: SystemOne, signal: AbortSignal): Promise<unknown> {
  try {
    await model.decide({ text: SYSTEM_ONE_CONTRACT_INPUT }, SYSTEM_ONE_CONTRACT_QUESTIONS, signal);
  } catch (error) {
    return error;
  }
  return null;
}

function answerContract(api: ContractApi, subject: SystemOneContractSubject): void {
  const { expect, test } = api;
  const decide = (questions: readonly Question[]): Promise<readonly Answer[]> =>
    subject
      .answers()
      .decide({ text: SYSTEM_ONE_CONTRACT_INPUT }, questions, new AbortController().signal);

  test('returns one answer per question, in question order', async () => {
    const answers = await decide(SYSTEM_ONE_CONTRACT_QUESTIONS);
    expect(answers.map((answer) => answer.id)).toEqual(['damaged', 'topic', 'severity']);
  });

  test('every answer has the type of its question, or is a refusal', async () => {
    const answers = await decide(SYSTEM_ONE_CONTRACT_QUESTIONS);
    const allowed = SYSTEM_ONE_CONTRACT_QUESTIONS.map((question, index) => {
      const type = answers[index]?.type;
      return type === question.type || type === 'refusal';
    });
    expect(allowed).toEqual([true, true, true]);
  });

  test('a choice is one of the options offered, and every number is in range', async () => {
    const answers = await decide(SYSTEM_ONE_CONTRACT_QUESTIONS);
    const legal = SYSTEM_ONE_CONTRACT_QUESTIONS.map((question, index) =>
      fits(question, answers[index]),
    );
    expect(legal).toEqual([true, true, true]);
  });
}

function errorContract(api: ContractApi, subject: SystemOneContractSubject): void {
  const { expect, test } = api;
  test('a rate limit or server error is a SystemOneError marked retryable', async () => {
    const error = await failure(subject.retryableError(), new AbortController().signal);
    expect(error instanceof SystemOneError).toBe(true);
    if (error instanceof SystemOneError) {
      expect(error.retryable).toBe(true);
      expect(error.model.length > 0 && error.provider.length > 0).toBe(true);
    }
  });

  test('a rejected request is a SystemOneError marked not retryable', async () => {
    const error = await failure(subject.fatalError(), new AbortController().signal);
    expect(error instanceof SystemOneError).toBe(true);
    if (error instanceof SystemOneError) {
      expect(error.retryable).toBe(false);
    }
  });

  test('an aborted signal rejects the call with a SystemOneError', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(subject.answers(), controller.signal);
    expect(error instanceof SystemOneError).toBe(true);
  });
}

/**
 * The contract every `system-one` entity must keep. Run it against a provider of your
 * own before registering it.
 */
export function systemOneContract(
  api: ContractApi,
  name: string,
  subject: SystemOneContractSubject,
): void {
  api.describe(`system-one contract: ${name}`, () => {
    api.test('declares its address and locality', () => {
      const model = subject.answers();
      api.expect(model.ref.kind).toBe('system-one');
      api.expect(model.ref.id.length > 0).toBe(true);
    });
    answerContract(api, subject);
    errorContract(api, subject);
  });
}
