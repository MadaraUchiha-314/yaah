/**
 * The System One interface: fast, cheap, typed judgements about one input — is this
 * statement true, which of these options fits, how does it rate — each with a
 * probability. It is separate from the LLM interface: no tools, no streaming, no
 * conversation. Every provider is a `system-one` entity implementing {@link SystemOne}.
 */
import type { Entity } from '../../../kernel/entity.ts';
import { YaahError } from '../../../kernel/errors.ts';

declare module '../../../kernel/entity.ts' {
  interface EntityMap {
    'system-one': SystemOne;
  }
}

/** What every question of one call is asked about. */
export interface SystemOneInput {
  /** The text to judge: a message, a document, a transcript. */
  readonly text: string;
}

/** One option of a {@link Question} of type `choice`. */
export interface Choice {
  /** What the answer carries when this option is picked. Unique within its question. */
  readonly value: string;
  /** What the option means, when the value alone does not say. */
  readonly description?: string | undefined;
}

/** One step of the ordered scale of a {@link Question} of type `score`. */
export interface ScoreLevel {
  readonly label: string;
  readonly description?: string | undefined;
}

/**
 * One question about the input.
 *
 * Invariants: `id` is unique within a call. A `choice` offers at least two options with
 * distinct values; a `score` offers at least two levels, lowest first.
 */
export type Question =
  | { readonly type: 'predicate'; readonly id: string; readonly text: string }
  | {
      readonly type: 'choice';
      readonly id: string;
      readonly text: string;
      readonly choices: readonly Choice[];
    }
  | {
      readonly type: 'score';
      readonly id: string;
      readonly text: string;
      readonly levels: readonly ScoreLevel[];
    };

/**
 * The answer to one {@link Question}; `id` is the question's.
 *
 * Invariants: every probability and confidence is within 0–1. A `choice` answer's
 * `choice` is the `value` of one of the options offered. A `score` answer's `score` is
 * the probability-weighted mean of the level indices, which start at 0, so it lies within
 * 0 and `levels.length - 1` and may fall between two levels. A `refusal` stands in for an
 * answer of any type: the model declined that one question.
 */
export type Answer =
  | { readonly type: 'predicate'; readonly id: string; readonly probability: number }
  | {
      readonly type: 'choice';
      readonly id: string;
      readonly choice: string;
      readonly confidence: number;
    }
  | {
      readonly type: 'score';
      readonly id: string;
      readonly score: number;
      readonly confidence: number;
    }
  | { readonly type: 'refusal'; readonly id: string; readonly reason: string };

/** A model that makes fast typed judgements. */
export interface SystemOne extends Entity<'system-one'> {
  /**
   * Answers every question about `input` in one call.
   *
   * Returns exactly one answer per question, in the order the questions were given; the
   * answer at index `i` has the id of question `i` and either its type or `refusal`.
   * Aborting `signal` rejects the call promptly.
   *
   * @throws SystemOneError when the provider fails, the call is aborted, or the provider's
   *   answers do not line up with the questions. `retryable` says whether trying again
   *   can help.
   */
  decide(
    input: SystemOneInput,
    questions: readonly Question[],
    signal: AbortSignal,
  ): Promise<readonly Answer[]>;
}

/** A System One call failed. */
export class SystemOneError extends YaahError {
  readonly provider: string;
  readonly model: string;
  /** True for rate limits, timeouts and server errors; false for bad requests and auth. */
  readonly retryable: boolean;

  constructor(
    provider: string,
    model: string,
    retryable: boolean,
    message: string,
    cause?: unknown,
  ) {
    super(retryable ? 'system-one.retryable' : 'system-one.fatal', message, cause);
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
  }
}
