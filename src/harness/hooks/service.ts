/**
 * Hooks: functions run at fixed points of a task's life. At a blocking point a hook may
 * refuse what is about to happen; at the others it only watches.
 */
import type { Json } from '../../kernel/json.ts';
import { t } from '../../kernel/strings.ts';

/** What every tool-related event says about the call. */
interface CallFacts {
  readonly taskId: string;
  /** The step the call runs as. */
  readonly key: string;
  /** The model's id for the call. */
  readonly callId: string;
  readonly args: Json;
}

/**
 * The lifecycle points and what a hook is told at each. Every payload is plain JSON, so
 * the same event can be handed to a hook in another process.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- type literals are assignable to JSON objects, interfaces are not
export type HookEvents = {
  /** A message arrived and no command answered it. Blocking: a refused message is not delivered. */
  'message.received': {
    /** Null for a message that would start a task. */
    readonly taskId: string | null;
    readonly contextId: string;
    readonly text: string;
  };
  /** The model is about to be called. */
  'llm.before': { readonly taskId: string; readonly key: string };
  /** The model answered; `toolCalls` names the tools it asked for. */
  'llm.after': {
    readonly taskId: string;
    readonly key: string;
    readonly toolCalls: readonly string[];
  };
  /** A tool is about to run. Blocking: a refused call does not run. */
  'tool.before': CallFacts & { readonly tool: string };
  /** A tool call ended, whether it ran, failed or was refused. */
  'tool.after': CallFacts & { readonly tool: string; readonly ok: boolean };
  /** A sub-agent is about to be invoked. Blocking: a refused invocation is not made. */
  'agent.before': CallFacts & { readonly agent: string };
  /** The task's status changed. */
  'task.transition': {
    readonly taskId: string;
    readonly key: string;
    /** Why: `turn-start`, `turn-complete`, `ask-user`, `client-complete`, `cancel`, `error`. */
    readonly reason: string;
    readonly state: string;
    readonly subState: string | null;
  };
};

/** The name of a lifecycle point. */
export type HookName = keyof HookEvents;

/** Every lifecycle point, in the order a task meets them. */
export const HOOK_NAMES: readonly HookName[] = [
  'message.received',
  'llm.before',
  'llm.after',
  'tool.before',
  'tool.after',
  'agent.before',
  'task.transition',
];

/** The points at which a `deny` stops what was about to happen. */
export const BLOCKING_HOOKS: ReadonlySet<HookName> = new Set([
  'message.received',
  'tool.before',
  'agent.before',
]);

/** What a hook decides. `reason` is shown to whoever was refused. */
export type HookDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string };

/** What a hook's function returns; nothing means `allow`. */
export type HookResult = HookDecision | undefined;

/** A hook for the point `E`. */
export interface Hook<E extends HookName> {
  /**
   * A glob (`*` any run of characters, `?` one) over the event's subject: the tool id for
   * `tool.*`, the agent id for `agent.before`. Absent means every event. At a point
   * without a subject it is ignored.
   */
  readonly match?: string | undefined;
  /** At a blocking point, throwing counts as `deny`. Elsewhere the result is ignored. */
  run(event: HookEvents[E]): HookResult | Promise<HookResult>;
}

/** Told when a hook threw. */
export type HookFailureListener = (event: HookName, error: unknown) => void;

const ALLOW: HookDecision = { decision: 'allow' };

/** Compiles a glob into an expression that must match the whole subject. */
export function globToRegExp(glob: string): RegExp {
  const source = glob
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'u');
}

function subjectOf(payload: HookEvents[HookName]): string | null {
  if ('tool' in payload) {
    return payload.tool;
  }
  return 'agent' in payload ? payload.agent : null;
}

type Registered = { [E in HookName]: { hook: Hook<E>; match: RegExp | null }[] };

/**
 * The hooks registered in one harness.
 *
 * Invariants:
 * - Hooks of a point run one after another, in the order they were registered.
 * - At a blocking point the first `deny` is the outcome and later hooks do not run; a
 *   hook that throws there denies.
 * - {@link Hooks.dispatch} never rejects.
 */
export class Hooks {
  readonly #registered: Registered = {
    'message.received': [],
    'llm.before': [],
    'llm.after': [],
    'tool.before': [],
    'tool.after': [],
    'agent.before': [],
    'task.transition': [],
  };
  readonly #onFailure: HookFailureListener;

  constructor(onFailure: HookFailureListener = (): void => undefined) {
    this.#onFailure = onFailure;
  }

  /** Adds a hook to the point `event`. Returns a function that removes it. */
  register<E extends HookName>(event: E, hook: Hook<E>): () => void {
    const entry = { hook, match: hook.match === undefined ? null : globToRegExp(hook.match) };
    const list: { hook: Hook<E>; match: RegExp | null }[] = this.#registered[event];
    list.push(entry);
    return (): void => {
      const index = list.indexOf(entry);
      if (index !== -1) {
        list.splice(index, 1);
      }
    };
  }

  /**
   * Runs the hooks of `event` whose `match` fits the payload.
   *
   * @returns `deny` with the first refusing hook's reason at a blocking point; `allow`
   *   otherwise, always so at a point that does not block.
   */
  async dispatch<E extends HookName>(event: E, payload: HookEvents[E]): Promise<HookDecision> {
    const blocking = BLOCKING_HOOKS.has(event);
    const subject = subjectOf(payload);
    const list: readonly { hook: Hook<E>; match: RegExp | null }[] = [...this.#registered[event]];
    for (const { hook, match } of list) {
      if (match !== null && subject !== null && !match.test(subject)) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- hooks run in order; the first deny ends it
        const result = await hook.run(payload);
        if (blocking && result?.decision === 'deny') {
          return result;
        }
      } catch (error) {
        this.#onFailure(event, error);
        if (blocking) {
          const reason = error instanceof Error ? error.message : String(error);
          return { decision: 'deny', reason: t('hooks.error.threw', { reason }) };
        }
      }
    }
    return ALLOW;
  }
}
