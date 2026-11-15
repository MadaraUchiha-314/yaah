import { describe, expect, test } from 'bun:test';

import { formatPlan, validatePlanSteps } from './plan.ts';
import type { PlanStep } from './types.ts';

const step = (name: string, dependsOn: string[] = []): PlanStep => ({
  name,
  description: `do ${name}`,
  dependsOn,
  status: 'pending',
  linkedTasks: [],
});

describe('validatePlanSteps', () => {
  test('accepts a directed acyclic graph', () => {
    expect(validatePlanSteps([step('a'), step('b', ['a']), step('c', ['a', 'b'])])).toBeNull();
  });

  test('accepts an empty plan and independent steps', () => {
    expect(validatePlanSteps([])).toBeNull();
    expect(validatePlanSteps([step('a'), step('b')])).toBeNull();
  });

  test('rejects a duplicate step name, naming it', () => {
    expect(validatePlanSteps([step('a'), step('a')])).toContain('"a"');
  });

  test('rejects a dependency on an unknown step, naming both', () => {
    const problem = validatePlanSteps([step('a', ['ghost'])]);
    expect(problem).toContain('"a"');
    expect(problem).toContain('"ghost"');
  });

  test('rejects a cycle, naming the steps in it', () => {
    const problem = validatePlanSteps([
      step('a', ['c']),
      step('b', ['a']),
      step('c', ['b']),
      step('d'),
    ]);
    expect(problem).toContain('cycle');
    expect(problem).toContain('a, b, c');
    expect(problem).not.toContain('d');
  });

  test('rejects a step that depends on itself', () => {
    expect(validatePlanSteps([step('a', ['a'])])).toContain('cycle');
  });
});

describe('formatPlan', () => {
  test('shows status, name, dependencies, description and output', () => {
    const plan = {
      taskId: 't',
      revision: 1,
      steps: [step('a'), { ...step('b', ['a']), status: 'done' as const, output: 'ok' }],
    };
    expect(formatPlan(plan)).toBe('- [pending] a: do a\n- [done] b (after a): do b — output: ok');
  });
});
