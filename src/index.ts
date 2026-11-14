/**
 * yaah — Yet Another Agent Harness.
 *
 * Public entry point. Real exports land here as the harness is built out.
 */

/** The package name, exported so the entry point is non-empty and testable. */
export const NAME = 'yaah';

/** Returns a greeting for the given name. */
export function greet(name: string): string {
  return `Hello from ${NAME}, ${name}!`;
}
