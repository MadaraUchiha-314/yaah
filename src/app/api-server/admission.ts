/**
 * Admission: the check a message passes before the SDK's request handler does anything
 * with it. A refused message never creates a task, never reaches the inbox and never
 * reaches a model — the caller gets an A2A error instead of a task.
 */
import type { AgentCard, Message, SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { AgentExecutor, ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';

import { YaahError } from '../../kernel/yaah-error.ts';

/**
 * Decides whether a message may enter. It resolves to admit the message.
 *
 * @throws YaahError to refuse it; the error's message is what the caller is told.
 */
export type Admission = (message: Message) => Promise<void>;

/** The admission checks in force. Plugins add theirs; every one must admit a message. */
export class AdmissionGate {
  readonly #checks = new Set<Admission>();

  /** Adds a check. Returns a function that removes it. */
  add(check: Admission): () => void {
    this.#checks.add(check);
    return (): void => {
      this.#checks.delete(check);
    };
  }

  /**
   * Runs every check on `message`, in the order they were added.
   *
   * @throws RequestMalformedError (A2A invalid-params, HTTP 400) carrying the refusal's
   *   message and its code, when a check refuses.
   * @throws whatever a check throws that is not a refusal.
   */
  async check(message: Message | undefined): Promise<void> {
    if (message === undefined) {
      // The SDK reports a request without a message itself.
      return;
    }
    try {
      for (const admit of this.#checks) {
        // oxlint-disable-next-line no-await-in-loop -- checks run in order; the first refusal wins
        await admit(message);
      }
    } catch (error) {
      if (error instanceof YaahError) {
        throw new RequestMalformedError({ message: error.message, metadata: { code: error.code } });
      }
      throw error;
    }
  }

  /** Builds the SDK's request handler with this gate in front of it. */
  handler(card: AgentCard, store: TaskStore, executor: AgentExecutor): DefaultRequestHandler {
    // oxlint-disable-next-line no-use-before-define -- the two classes name each other
    return new AdmittingRequestHandler(this, card, store, executor);
  }
}

/** The SDK's request handler with the admission gate in front of both ways to send. */
export class AdmittingRequestHandler extends DefaultRequestHandler {
  readonly #gate: AdmissionGate;

  constructor(gate: AdmissionGate, card: AgentCard, store: TaskStore, executor: AgentExecutor) {
    super(card, store, executor);
    this.#gate = gate;
  }

  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Message | Task> {
    await this.#gate.check(params.message);
    return super.sendMessage(params, context);
  }

  override async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    await this.#gate.check(params.message);
    yield* super.sendMessageStream(params, context);
  }
}
