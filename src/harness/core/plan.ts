/** Plans: validation and the text a model reads. Pure. */
import type { Plan, PlanStep } from './types.ts';

/**
 * Checks that the steps form a directed acyclic graph.
 *
 * @returns null when valid; otherwise the reason, in words a model can act on.
 */
export function validatePlanSteps(steps: readonly PlanStep[]): string | null {
  const names = new Set<string>();
  for (const step of steps) {
    if (names.has(step.name)) {
      return `Step name "${step.name}" is used more than once.`;
    }
    names.add(step.name);
  }
  for (const step of steps) {
    const unknown = step.dependsOn.find((dependency: string) => !names.has(dependency));
    if (unknown !== undefined) {
      return `Step "${step.name}" depends on "${unknown}", which is not a step of the plan.`;
    }
  }
  // Kahn's algorithm: repeatedly remove steps with no remaining dependency.
  const remaining = new Map<string, Set<string>>(
    steps.map((step: PlanStep) => [step.name, new Set(step.dependsOn)]),
  );
  for (;;) {
    const ready = [...remaining].filter(([, needs]) => needs.size === 0).map(([name]) => name);
    if (ready.length === 0) {
      break;
    }
    for (const name of ready) {
      remaining.delete(name);
      for (const needs of remaining.values()) {
        needs.delete(name);
      }
    }
  }
  return remaining.size === 0
    ? null
    : `The plan has a cycle among: ${[...remaining.keys()].toSorted().join(', ')}.`;
}

/** One line per step: status, name, dependencies, description. */
export function formatPlan(plan: Plan): string {
  return plan.steps
    .map((step: PlanStep) => {
      const after = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(', ')})` : '';
      const output = step.output === undefined ? '' : ` — output: ${step.output}`;
      return `- [${step.status}] ${step.name}${after}: ${step.description}${output}`;
    })
    .join('\n');
}
