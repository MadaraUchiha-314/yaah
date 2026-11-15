import { describe, expect, test } from 'bun:test';

import type { TaskState } from './step-runner.ts';
import { isTerminal, nextStatus } from './transitions.ts';

describe('nextStatus', () => {
  test('a turn starts in working', () => {
    expect(nextStatus(true, { reason: 'turn-start' })).toEqual({
      state: 'working',
      subState: null,
    });
  });

  test('an answer completes a task that is not long-running', () => {
    expect(nextStatus(false, { reason: 'turn-complete' })).toEqual({
      state: 'completed',
      subState: null,
    });
  });

  test('an answer leaves a long-running task awaiting the next interaction', () => {
    expect(nextStatus(true, { reason: 'turn-complete' })).toEqual({
      state: 'input-required',
      subState: 'awaiting-next-interaction',
    });
  });

  test('a question leaves any task awaiting user input', () => {
    for (const longRunning of [true, false]) {
      expect(nextStatus(longRunning, { reason: 'ask-user', callId: 'c', question: 'q' })).toEqual({
        state: 'input-required',
        subState: 'awaiting-user-input',
      });
    }
  });

  test('complete, cancel and error are terminal whatever the task', () => {
    expect(nextStatus(true, { reason: 'client-complete' }).state).toBe('completed');
    expect(nextStatus(true, { reason: 'cancel' }).state).toBe('canceled');
    expect(nextStatus(true, { reason: 'error', cause: 'x' }).state).toBe('failed');
  });
});

describe('isTerminal', () => {
  test('completed, canceled and failed are terminal; working and input-required are not', () => {
    const terminal: TaskState[] = ['completed', 'canceled', 'failed'];
    expect(terminal.every((state) => isTerminal(state))).toBe(true);
    expect(isTerminal('working')).toBe(false);
    expect(isTerminal('input-required')).toBe(false);
  });
});
