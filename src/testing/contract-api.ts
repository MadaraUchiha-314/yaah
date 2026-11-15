/**
 * The slice of a test runner the contract suites need. `bun:test`, Vitest and Jest all
 * satisfy it, so an operator can run yaah's contracts against their own implementation
 * with whichever runner they use:
 *
 * ```ts
 * import { describe, expect, test } from 'bun:test';
 * persistenceContract({ describe, expect, test }, () => myBackend());
 * ```
 */
export interface ContractApi {
  readonly describe: (name: string, body: () => void) => void;
  /** `timeoutMs`, when given, replaces the runner's default limit for that test. */
  readonly test: (name: string, body: () => void | Promise<void>, timeoutMs?: number) => void;
  readonly expect: (actual: unknown) => ContractMatchers;
}

/** The matchers the suites use. */
export interface ContractMatchers {
  readonly toBe: (expected: unknown) => void;
  readonly toEqual: (expected: unknown) => void;
  readonly toBeUndefined: () => void;
  readonly toContain: (expected: unknown) => void;
  /** Negates the next matcher. */
  readonly not: ContractMatchers;
}
