/** A fixture plugin that fails while starting. */
export const name = 'fixture-throws';

export function apply(): void {
  throw new Error('boom from fixture');
}
