import { describe, expect, test } from 'bun:test';

import { MemoryTaskPort, blankTaskModel } from './memory-task-port.ts';

describe('MemoryTaskPort', () => {
  test('applies a status once per step key and records it', async () => {
    const port = new MemoryTaskPort();
    port.create({ taskId: 't1' });
    const update = { state: 'completed', subState: null, message: [] } as const;
    await port.setStatus('t1', 'k1', update);
    await port.setStatus('t1', 'k1', { ...update, state: 'failed' });
    expect((await port.load('t1')).state).toBe('completed');
    expect(port.history.length).toBe(1);
  });

  test('replaces the task model once per step key', async () => {
    const port = new MemoryTaskPort();
    port.create({ taskId: 't1' });
    await port.setModel('t1', 'k1', blankTaskModel({ name: 'First' }));
    await port.setModel('t1', 'k1', blankTaskModel({ name: 'Again' }));
    expect((await port.load('t1')).model.name).toBe('First');
  });

  test('records the model and effort chosen for a task', async () => {
    const port = new MemoryTaskPort();
    port.create({ taskId: 't1' });
    await port.select('t1', { llm: 'openai/x', effort: 'high' });
    expect(await port.load('t1')).toMatchObject({ llm: 'openai/x', effort: 'high' });
  });

  test('rejects an unknown task', async () => {
    let message = '';
    try {
      await new MemoryTaskPort().load('nope');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('nope');
  });
});
