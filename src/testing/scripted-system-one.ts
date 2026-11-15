/**
 * A System One model that replays a script — deterministic and offline. It records every
 * call it receives so a test can assert on exactly what was asked, and whether anything
 * was asked at all.
 */
import { LOCAL } from '../kernel/entity.ts';
import type {
  Answer,
  Question,
  SystemOne,
  SystemOneInput,
} from '../harness/models/system-one/types.ts';
import { SystemOneError } from '../harness/models/system-one/types.ts';

/** What the scripted model does on one call. */
export type ScriptedDecision =
  | readonly Answer[]
  | ((input: SystemOneInput, questions: readonly Question[]) => readonly Answer[])
  | { readonly error: SystemOneError };

/** One call the scripted model received. */
export interface ScriptedSystemOneCall {
  readonly input: SystemOneInput;
  readonly questions: readonly Question[];
}

/** Options of {@link ScriptedSystemOne}. */
export interface ScriptedSystemOneOptions {
  readonly id?: string;
  /** Milliseconds to wait before answering, to make time-outs and aborts observable. */
  readonly delayMs?: number;
}

const PROVIDER = 'scripted';

/**
 * A decision that answers every question the same way: each predicate with
 * `probability`, each choice with the first option offered, each score with its lowest
 * level.
 */
export function answerAll(
  probability: number,
): (input: SystemOneInput, questions: readonly Question[]) => readonly Answer[] {
  return (_input: SystemOneInput, questions: readonly Question[]): readonly Answer[] =>
    questions.map((question: Question): Answer => {
      if (question.type === 'predicate') {
        return { type: 'predicate', id: question.id, probability };
      }
      if (question.type === 'choice') {
        const choice = question.choices[0]?.value ?? '';
        return { type: 'choice', id: question.id, choice, confidence: 1 };
      }
      return { type: 'score', id: question.id, score: 0, confidence: 1 };
    });
}

/** A scripted `system-one` entity. The last decision of the script repeats. */
export class ScriptedSystemOne implements SystemOne {
  readonly ref: SystemOne['ref'];
  readonly description = 'A scripted System One model for tests.';
  readonly locality: SystemOne['locality'] = LOCAL;
  /** Every call received, in order. */
  readonly calls: ScriptedSystemOneCall[] = [];
  readonly #script: readonly ScriptedDecision[];
  readonly #delayMs: number;

  constructor(script: readonly ScriptedDecision[], options: ScriptedSystemOneOptions = {}) {
    this.#script = [...script];
    this.#delayMs = options.delayMs ?? 0;
    this.ref = { kind: 'system-one', id: options.id ?? 'scripted/system-one', version: null };
  }

  /**
   * Plays the next decision of the script.
   *
   * @throws SystemOneError when the script says so, when it is empty, or when `signal`
   *   aborts before the answer is due.
   */
  async decide(
    input: SystemOneInput,
    questions: readonly Question[],
    signal: AbortSignal,
  ): Promise<readonly Answer[]> {
    const index = Math.min(this.calls.length, this.#script.length - 1);
    this.calls.push({ input, questions });
    await this.#wait(signal);
    const decision = this.#script[index];
    if (decision === undefined) {
      throw new SystemOneError(PROVIDER, this.ref.id, false, 'the script is empty');
    }
    if (typeof decision === 'function') {
      return decision(input, questions);
    }
    if ('error' in decision) {
      throw decision.error;
    }
    return decision;
  }

  #wait(signal: AbortSignal): Promise<void> {
    const aborted = (): SystemOneError =>
      new SystemOneError(PROVIDER, this.ref.id, false, 'aborted');
    return new Promise((resolve: () => void, reject: (reason: SystemOneError) => void) => {
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      const timer = setTimeout(resolve, this.#delayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(aborted());
        },
        { once: true },
      );
    });
  }
}
