/**
 * The OpenAI System One provider: one `system-one` entity on the Decisions API
 * (`POST /v1/decisions`) of the official SDK. Every question of a call travels in one
 * request; the answers come back in question order.
 */
import OpenAI from 'openai';
import type { Decision, DecisionCreateParams } from 'openai/resources/decisions';

import { t } from '../../../../kernel/strings.ts';
import type { FetchLike } from '../../llm/openai/content.ts';
import type { ErrorScope } from '../../llm/openai/errors.ts';
import { OPENAI_BASE_URL } from '../../llm/openai/provider.ts';
import { OPENAI } from '../../llm/openai/request.ts';
import type { Answer, Choice, Question, ScoreLevel, SystemOne, SystemOneInput } from '../types.ts';
import { mismatchError, toSystemOneError } from './errors.ts';

/** The decisions model used unless the configuration names another. */
export const OPENAI_SYSTEM_ONE_MODEL = 'gpt-6-luna';

/** What {@link createOpenAiSystemOne} needs. */
export interface OpenAiSystemOneOptions {
  /** The model id as OpenAI names it. Defaults to {@link OPENAI_SYSTEM_ONE_MODEL}. */
  readonly model?: string | undefined;
  /** The API key. Sent only as the bearer token; never logged or put in an error. */
  readonly apiKey: string;
  /** Defaults to OpenAI's own API. */
  readonly baseUrl?: string | undefined;
  /** Replaces the global `fetch`; tests use it to replay canned responses. */
  readonly fetch?: FetchLike | undefined;
}

type QuestionParam = DecisionCreateParams['questions'][number];
type AnswerResource = Decision['answers'][number];

function choiceParam(choice: Choice): { value: string; description?: string } {
  return choice.description === undefined
    ? { value: choice.value }
    : { value: choice.value, description: choice.description };
}

function levelParam(level: ScoreLevel): { label: string; description?: string } {
  return level.description === undefined
    ? { label: level.label }
    : { label: level.label, description: level.description };
}

/** A question as the Decisions API takes it; the question's id travels as its `name`. */
function questionParam(question: Question): QuestionParam {
  const base = { name: question.id, instructions: question.text };
  switch (question.type) {
    case 'predicate': {
      return { ...base, type: 'predicate' };
    }
    case 'choice': {
      return { ...base, type: 'choice', choices: question.choices.map(choiceParam) };
    }
    default: {
      return { ...base, type: 'score', levels: question.levels.map(levelParam) };
    }
  }
}

/**
 * The answer to `question` from what the API returned at its position.
 *
 * @throws SystemOneError when there is no answer there, it is of another type, or it
 *   picks a choice that was not offered.
 */
function answerOf(
  scope: ErrorScope,
  question: Question,
  resource: AnswerResource | undefined,
): Answer {
  const { id } = question;
  if (resource?.type === 'refusal') {
    return { type: 'refusal', id, reason: t('system-one.refusal') };
  }
  if (resource?.type === 'predicate' && question.type === 'predicate') {
    return { type: 'predicate', id, probability: resource.probability };
  }
  if (resource?.type === 'score' && question.type === 'score') {
    return { type: 'score', id, score: resource.score, confidence: resource.confidence };
  }
  if (resource?.type === 'choice' && question.type === 'choice') {
    const { choice } = resource;
    if (
      typeof choice === 'string' &&
      question.choices.some((offered) => offered.value === choice)
    ) {
      return { type: 'choice', id, choice, confidence: resource.confidence };
    }
  }
  throw mismatchError(scope);
}

function answersOf(
  scope: ErrorScope,
  questions: readonly Question[],
  decision: Decision,
): readonly Answer[] {
  try {
    if (decision.answers.length !== questions.length) {
      throw mismatchError(scope);
    }
    return questions.map((question, index) => answerOf(scope, question, decision.answers[index]));
  } catch {
    // A body that is not a decision at all reads the same as one that does not line up.
    throw mismatchError(scope);
  }
}

/**
 * Creates the `system-one` entity `openai/<model>`.
 *
 * The entity never retries: a failed call is one `SystemOneError`, and its `retryable`
 * flag tells the caller whether to try again.
 */
export function createOpenAiSystemOne(options: OpenAiSystemOneOptions): SystemOne {
  const model = options.model ?? OPENAI_SYSTEM_ONE_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    // In a browser the SDK refuses to start without this. Whoever starts a harness in a tab
    // has already decided whose key or proxy it calls; on Node the flag does nothing.
    dangerouslyAllowBrowser: true,
    // Ambient OPENAI_ORG_ID / OPENAI_PROJECT_ID must not change what a configured model does.
    organization: null,
    project: null,
    fetch: options.fetch,
  });
  const scope: ErrorScope = { provider: OPENAI, model, secrets: [options.apiKey] };
  const ask = async (
    input: SystemOneInput,
    questions: readonly Question[],
    signal: AbortSignal,
  ): Promise<Decision> => {
    try {
      signal.throwIfAborted();
      const params = {
        model,
        input: input.text,
        questions: questions.map((question) => questionParam(question)),
      };
      return await client.decisions.create(params, { signal });
    } catch (error) {
      throw toSystemOneError(scope, error, signal);
    }
  };
  return {
    ref: { kind: 'system-one', id: `${OPENAI}/${model}`, version: null },
    description: t('system-one.openai.description', { model }),
    locality: { type: 'remote', protocol: 'https', url: baseUrl },
    decide: async (
      input: SystemOneInput,
      questions: readonly Question[],
      signal: AbortSignal,
    ): Promise<readonly Answer[]> =>
      answersOf(scope, questions, await ask(input, questions, signal)),
  };
}
