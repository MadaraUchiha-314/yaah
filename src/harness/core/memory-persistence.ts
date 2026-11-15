/**
 * An in-memory persistence backend: the default of the browser build, and what tests
 * run on. Nothing survives the process.
 */
import type { Json } from '../../kernel/json.ts';
import type {
  ConversationStore,
  InboxStore,
  Persistence,
  PlanStore,
  StateStore,
  StepJournal,
  StepRecord,
} from './persistence.ts';
import type {
  ConversationEvent,
  ConversationEventBody,
  InboxItem,
  Plan,
  SeqRange,
  StepKey,
  TaskId,
} from './types.ts';

function taskOfKey(key: StepKey): TaskId {
  return key.split('/')[0] ?? '';
}

class MemoryConversationStore implements ConversationStore {
  readonly #events = new Map<TaskId, ConversationEvent[]>();
  readonly #next = new Map<TaskId, number>();

  put(taskId: TaskId, key: StepKey, events: readonly ConversationEventBody[]): Promise<void> {
    const all = this.#events.get(taskId) ?? [];
    // Events rewritten by the same step keep their positions; extra ones go to the end.
    const reusable = all
      .filter((event: ConversationEvent) => event.key === key)
      .map((event: ConversationEvent) => event.seq);
    const kept = all.filter((event: ConversationEvent) => event.key !== key);
    let next = this.#next.get(taskId) ?? 0;
    for (const [index, body] of events.entries()) {
      const reused = reusable[index];
      kept.push({ ...body, seq: reused ?? next, key });
      next += reused === undefined ? 1 : 0;
    }
    this.#next.set(taskId, next);
    this.#events.set(
      taskId,
      kept.toSorted((a: ConversationEvent, b: ConversationEvent) => a.seq - b.seq),
    );
    return Promise.resolve();
  }

  read(taskId: TaskId, range?: SeqRange): Promise<readonly ConversationEvent[]> {
    const all = this.#events.get(taskId) ?? [];
    return Promise.resolve(
      range === undefined
        ? [...all]
        : all.filter((event: ConversationEvent) => event.seq >= range.from && event.seq < range.to),
    );
  }
}

class MemoryStateStore implements StateStore {
  readonly #values = new Map<string, Json>();
  readonly #applied = new Set<StepKey>();

  get(taskId: TaskId, name: string): Promise<Json | undefined> {
    return Promise.resolve(this.#values.get(`${taskId}\u0000${name}`));
  }

  set(taskId: TaskId, key: StepKey, name: string, value: Json): Promise<void> {
    const applied = `${key}\u0000${name}`;
    if (!this.#applied.has(applied)) {
      this.#applied.add(applied);
      this.#values.set(`${taskId}\u0000${name}`, value);
    }
    return Promise.resolve();
  }

  names(taskId: TaskId): Promise<readonly string[]> {
    const prefix = `${taskId}\u0000`;
    return Promise.resolve(
      [...this.#values.keys()]
        .filter((key: string) => key.startsWith(prefix))
        .map((key: string) => key.slice(prefix.length))
        .toSorted(),
    );
  }
}

class MemoryPlanStore implements PlanStore {
  readonly #plans = new Map<TaskId, Plan>();
  readonly #applied = new Set<StepKey>();

  load(taskId: TaskId): Promise<Plan | undefined> {
    return Promise.resolve(this.#plans.get(taskId));
  }

  save(key: StepKey, plan: Plan): Promise<void> {
    if (!this.#applied.has(key)) {
      this.#applied.add(key);
      this.#plans.set(plan.taskId, plan);
    }
    return Promise.resolve();
  }
}

class MemoryInboxStore implements InboxStore {
  readonly #items = new Map<string, InboxItem>();
  readonly #processed = new Set<string>();

  put(item: InboxItem): Promise<'stored' | 'duplicate'> {
    if (this.#items.has(item.id)) {
      return Promise.resolve('duplicate');
    }
    this.#items.set(item.id, item);
    return Promise.resolve('stored');
  }

  get(ids: readonly string[]): Promise<readonly InboxItem[]> {
    const found: InboxItem[] = [];
    for (const id of ids) {
      const item = this.#items.get(id);
      if (item !== undefined) {
        found.push(item);
      }
    }
    return Promise.resolve(found);
  }

  pending(taskId?: TaskId): Promise<readonly InboxItem[]> {
    return Promise.resolve(
      [...this.#items.values()].filter(
        (item: InboxItem) =>
          !this.#processed.has(item.id) && (taskId === undefined || item.taskId === taskId),
      ),
    );
  }

  markProcessed(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.#processed.add(id);
    }
    return Promise.resolve();
  }
}

class MemoryStepJournal implements StepJournal {
  readonly #records = new Map<StepKey, StepRecord>();

  get(key: StepKey): Promise<StepRecord | undefined> {
    return Promise.resolve(this.#records.get(key));
  }

  record(key: StepKey, result: Json): Promise<void> {
    if (!this.#records.has(key)) {
      this.#records.set(key, { key, result });
    }
    return Promise.resolve();
  }

  list(taskId: TaskId): Promise<readonly StepRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter((record: StepRecord) => taskOfKey(record.key) === taskId),
    );
  }
}

/** Creates an empty in-memory backend. */
export function createMemoryPersistence(): Persistence {
  return {
    conversation: new MemoryConversationStore(),
    state: new MemoryStateStore(),
    plan: new MemoryPlanStore(),
    inbox: new MemoryInboxStore(),
    journal: new MemoryStepJournal(),
  };
}
