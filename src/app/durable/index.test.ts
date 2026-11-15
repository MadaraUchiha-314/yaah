import { describe, expect, test } from 'bun:test';

import { defineTool, textResult } from '../../harness/tools/types.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import { isRetrySafe } from './index.ts';

const tool = (id: string, retrySafe: boolean) =>
  defineTool({
    id,
    description: id,
    inputSchema: { type: 'object' },
    retrySafe,
    invoke: () => Promise.resolve(textResult('')),
  });

describe('isRetrySafe', () => {
  const registry = new EntityRegistry();
  registry.register(tool('lookup', true));
  registry.register(tool('refund', false));
  const callOf = (name: string) => ({ call: { id: 'c1', name, args: {} } });

  test('every step but a tool call may be attempted again', () => {
    for (const step of ['llm.invoke', 'context.build', 'conversation.accept', 'task.transition']) {
      expect(isRetrySafe(registry, step, {})).toBe(true);
    }
  });

  test('a tool call follows what the tool declared', () => {
    expect(isRetrySafe(registry, 'tool.invoke', callOf('lookup'))).toBe(true);
    expect(isRetrySafe(registry, 'tool.invoke', callOf('refund'))).toBe(false);
  });

  test('a call to an unregistered tool is safe: it is refused without running', () => {
    expect(isRetrySafe(registry, 'tool.invoke', callOf('ghost'))).toBe(true);
    expect(isRetrySafe(registry, 'tool.invoke', null)).toBe(true);
  });
});
