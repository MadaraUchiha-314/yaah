/**
 * Inbox triage: when a message arrives for a task that is working and the client did not
 * say whether it interrupts, a System One model decides. One yes/no question — the
 * `inbox-triage` prompt — is asked about the message text.
 *
 * Triage can only ever add an interrupt. Whatever goes wrong — no such model, a provider
 * failure, a refusal, no answer in time — the message does not interrupt, which is what
 * happens without triage, and an `inbox/triaged` event says why.
 */
import type { Context } from 'cordis';

import type { SystemOne } from '../../harness/models/system-one/types.ts';
import { renderPrompt } from '../../harness/system-prompt/prompt.ts';
import { YaahError } from '../../kernel/errors.ts';
import { t } from '../../kernel/strings.ts';

/** What triage concluded about one message. */
export interface TriageOutcome {
  /** The id of the `system-one` entity that was asked. */
  readonly model: string;
  readonly interrupt: boolean;
  /** The probability the model gave that the message interrupts; null when it gave none. */
  readonly probability: number | null;
  /** Why there is no decision; null when the model answered. */
  readonly error: string | null;
}

/**
 * Decides whether the message `text`, which arrived as inbox item `itemId` for the
 * working task `taskId`, interrupts it. Never rejects.
 */
export type Triage = (taskId: string, itemId: string, text: string) => Promise<boolean>;

/** Options of {@link createTriage}. */
export interface TriageOptions {
  /** How long the model may take. Defaults to {@link TRIAGE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

declare module 'cordis' {
  interface Events {
    /** Triage classified, or failed to classify, a message for a working task. */
    'inbox/triaged'(taskId: string, itemId: string, outcome: TriageOutcome): void;
  }
}

/** How long a triage decision may take before the message is treated as not interrupting. */
export const TRIAGE_TIMEOUT_MS = 2000;
/** The id of the prompt entity that holds the triage question. */
export const TRIAGE_PROMPT = 'inbox-triage';
/** The probability from which a message interrupts. */
const THRESHOLD = 0.5;
const QUESTION_ID = 'interrupts';

/**
 * Asks `model` the triage question about `text`.
 *
 * @throws YaahError (`inbox.triage-timeout`) when no answer arrives within `timeoutMs`,
 *   (`inbox.triage-refused`) when the model gives no probability, and whatever the model
 *   throws.
 */
async function probabilityOf(
  model: SystemOne,
  question: string,
  text: string,
  timeoutMs: number,
): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeout = new Promise<never>((_resolve, reject: (reason: Error) => void) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new YaahError('inbox.triage-timeout', t('error.inbox.triage-timeout')));
    }, timeoutMs);
  });
  try {
    const [answer] = await Promise.race([
      model.decide(
        { text },
        [{ type: 'predicate', id: QUESTION_ID, text: question }],
        controller.signal,
      ),
      timeout,
    ]);
    if (answer?.type !== 'predicate') {
      throw new YaahError('inbox.triage-refused', t('error.inbox.triage-refused'));
    }
    return answer.probability;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the triage function of a harness whose `inbox.triage` is `system-one`. The
 * model `inbox.triage_model` and the prompt are resolved at each call, so either can be
 * registered, overridden or removed while the harness runs.
 */
export function createTriage(ctx: Context, options: TriageOptions = {}): Triage {
  const model = ctx.config.inbox.triageModel;
  const timeoutMs = options.timeoutMs ?? TRIAGE_TIMEOUT_MS;
  return async (taskId: string, itemId: string, text: string): Promise<boolean> => {
    if (text.trim() === '') {
      return false;
    }
    let outcome: TriageOutcome = { model, interrupt: false, probability: null, error: null };
    try {
      const entity = ctx.entities.resolve({ kind: 'system-one', id: model, version: null });
      const question = renderPrompt(ctx.entities, TRIAGE_PROMPT, {});
      const probability = await probabilityOf(entity, question, text, timeoutMs);
      outcome = { ...outcome, probability, interrupt: probability >= THRESHOLD };
    } catch (error) {
      outcome = { ...outcome, error: error instanceof Error ? error.message : String(error) };
    }
    ctx.emit('inbox/triaged', taskId, itemId, outcome);
    return outcome.interrupt;
  };
}
