/**
 * A model that replays a script — the test double the whole harness is proved with.
 * Deterministic, offline, and it records every request it receives so a test can assert
 * on exactly what the model was shown.
 */
import { LOCAL } from '../kernel/entity.ts';
import type { Json } from '../kernel/json.ts';
import type { ToolCall } from '../harness/core/types.ts';
import type {
  LLM,
  LlmCapabilities,
  LlmEvent,
  LlmRequest,
  StopReason,
} from '../harness/models/llm/types.ts';
import { LlmError, NO_USAGE } from '../harness/models/llm/types.ts';

/** What the scripted model does on one call. */
export type ScriptedTurn =
  | readonly LlmEvent[]
  | ((request: LlmRequest) => readonly LlmEvent[])
  | { readonly error: LlmError };

/** Options of {@link ScriptedLlm}. */
export interface ScriptedLlmOptions {
  readonly id?: string;
  readonly capabilities?: Partial<LlmCapabilities>;
  /** Milliseconds to wait before each event, to make streaming and interrupts observable. */
  readonly delayMs?: number;
  /** Tokens reported per call when a turn's `done` event does not say. */
  readonly usagePerCall?: { readonly inputTokens: number; readonly outputTokens: number };
}

function done(stopReason: StopReason): LlmEvent {
  return { type: 'done', usage: NO_USAGE, stopReason };
}

/** A turn in which the model says `text`, split into word-sized deltas. */
export function say(text: string): readonly LlmEvent[] {
  const deltas = text.match(/\S+\s*/gu) ?? [];
  return [
    ...deltas.map((delta: string): LlmEvent => ({ type: 'text.delta', text: delta })),
    done('end'),
  ];
}

/** A tool call with the given name and arguments. */
export function call(id: string, name: string, args: Json = {}): ToolCall {
  return { id, name, args };
}

/** A turn in which the model requests the given tool calls, all at once. */
export function callTools(...calls: readonly ToolCall[]): readonly LlmEvent[] {
  return [
    ...calls.map((toolCall: ToolCall): LlmEvent => ({ type: 'tool-call', call: toolCall })),
    done('tool-calls'),
  ];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void, reject: (reason: unknown) => void) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LlmError('scripted', 'scripted', false, 'aborted'));
      },
      { once: true },
    );
  });
}

/** A scripted `llm` entity. */
export class ScriptedLlm implements LLM {
  readonly ref: LLM['ref'];
  readonly description = 'A scripted model for tests.';
  readonly locality: LLM['locality'] = LOCAL;
  readonly capabilities: LlmCapabilities;
  /** Every request received, in order. */
  readonly requests: LlmRequest[] = [];
  readonly #turns: ScriptedTurn[];
  readonly #options: ScriptedLlmOptions;

  constructor(turns: readonly ScriptedTurn[], options: ScriptedLlmOptions = {}) {
    this.#turns = [...turns];
    this.#options = options;
    this.ref = { kind: 'llm', id: options.id ?? 'scripted/model', version: null };
    this.capabilities = {
      contextWindow: 100_000,
      maxOutput: 4096,
      input: [],
      efforts: ['low', 'medium', 'high'],
      ...options.capabilities,
    };
  }

  /** Appends turns to the script. */
  push(...turns: readonly ScriptedTurn[]): void {
    this.#turns.push(...turns);
  }

  /** How many scripted turns have not been played yet. */
  get remaining(): number {
    return this.#turns.length;
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    const turn = this.#turns.shift();
    if (turn === undefined) {
      throw new LlmError('scripted', this.ref.id, false, 'the script has no more turns');
    }
    if ('error' in turn) {
      throw turn.error;
    }
    const events = typeof turn === 'function' ? turn(request) : turn;
    for (const event of events) {
      if (signal.aborted) {
        throw new LlmError('scripted', this.ref.id, false, 'aborted');
      }
      if (this.#options.delayMs !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- events are emitted one after another
        await sleep(this.#options.delayMs, signal);
      }
      yield this.#withUsage(event);
    }
  }

  #withUsage(event: LlmEvent): LlmEvent {
    const usage = this.#options.usagePerCall;
    if (event.type !== 'done' || usage === undefined || event.usage !== NO_USAGE) {
      return event;
    }
    return { ...event, usage: { ...usage, cachedInputTokens: 0 } };
  }
}
