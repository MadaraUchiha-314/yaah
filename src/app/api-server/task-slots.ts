/**
 * Open-task slots held for requests that will create a task. The HTTP guard counts a
 * caller's open tasks before the admission checks run, and those may take a while: a
 * request that passed the count holds a slot until its task exists, so requests sent
 * meanwhile cannot all pass the same count.
 */

/** The header the HTTP layer sets to the slot a request holds. Never trusted from a client. */
export const SLOT_HEADER = 'x-yaah-slot';

/** The slots held, by token, each for one caller. */
export class TaskSlots {
  readonly #held = new Map<string, string>();
  #next: number;
  constructor() {
    this.#next = 0;
  }

  /** Holds a slot for `caller`. Returns the token that releases it. */
  reserve(caller: string): string {
    this.#next += 1;
    const token = String(this.#next);
    this.#held.set(token, caller);
    return token;
  }

  /** Releases the slot `token` names. Releasing one twice, or an unknown one, does nothing. */
  release(token: string): void {
    this.#held.delete(token);
  }

  /** How many slots `caller` holds. */
  held(caller: string): number {
    let count = 0;
    for (const holder of this.#held.values()) {
      if (holder === caller) {
        count += 1;
      }
    }
    return count;
  }
}
