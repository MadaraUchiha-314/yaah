import { expect, test } from 'bun:test';

import { addTraceparentSource, currentTraceparent } from './trace-context.ts';

test('the first source with a value answers, and a removed source no longer does', () => {
  expect(currentTraceparent()).toBeUndefined();
  const removeEmpty = addTraceparentSource(() => undefined);
  const remove = addTraceparentSource(() => '00-a-b-01');
  expect(currentTraceparent()).toBe('00-a-b-01');
  remove();
  remove();
  expect(currentTraceparent()).toBeUndefined();
  removeEmpty();
});
