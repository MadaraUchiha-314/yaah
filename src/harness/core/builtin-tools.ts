/**
 * The tools yaah itself provides. They act only on the task's own data — its plan, its
 * state, its question to the user. yaah ships no file, shell or network tool.
 */
import { Validator } from '@cfworker/json-schema';

import type { Json, JsonObject } from '../../kernel/json.ts';
import { isJsonObject } from '../../kernel/json.ts';
import { t } from '../../kernel/strings.ts';
import type { Tool } from '../tools/types.ts';
import { defineTool, errorResult, textResult } from '../tools/types.ts';
import { ASK_USER } from './loop.ts';
import type { PlanStore, StateStore } from './persistence.ts';
import { formatPlan, validatePlanSteps } from './plan.ts';
import type { PlanStep } from './types.ts';

/** What the built-in tools work with. */
export interface BuiltinToolDeps {
  readonly state: StateStore;
  readonly plan: PlanStore;
  /**
   * JSON Schemas for parts of the state, by name prefix. A value stored under a name
   * with a registered prefix must match that prefix's schema.
   */
  readonly stateSchemas?: ReadonlyMap<string, JsonObject>;
}

const STATUSES = ['pending', 'in-progress', 'done', 'skipped', 'failed'] as const;

function isStatus(value: Json | undefined): value is PlanStep['status'] {
  return STATUSES.some((status: string) => status === value);
}

function text(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

function toStep(raw: Json): PlanStep {
  const fields = isJsonObject(raw) ? raw : {};
  const depends = fields['dependsOn'];
  return {
    name: text(fields['name']),
    description: text(fields['description']),
    dependsOn: Array.isArray(depends)
      ? depends.filter((entry: Json) => typeof entry === 'string')
      : [],
    status: 'pending',
    linkedTasks: [],
  };
}

function askUser(): Tool {
  return defineTool({
    id: ASK_USER,
    description: t('tool.ask-user.description'),
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', minLength: 1 } },
      required: ['question'],
      additionalProperties: false,
    },
    // The loop suspends on the first ask_user of a reply and never runs it as a tool.
    // Only an extra one in the same reply reaches this function.
    invoke: () => Promise.resolve(errorResult('one-at-a-time', t('tool.ask-user.one-at-a-time'))),
  });
}

function planSet(deps: BuiltinToolDeps): Tool {
  return defineTool({
    id: 'plan_set',
    description: t('tool.plan-set.description'),
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              description: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args, ctx) => {
      const raw = isJsonObject(args) ? args['steps'] : undefined;
      const steps = Array.isArray(raw) ? raw.map((entry: Json) => toStep(entry)) : [];
      const problem = validatePlanSteps(steps);
      if (problem !== null) {
        return errorResult('invalid-plan', problem);
      }
      const previous = await deps.plan.load(ctx.taskId);
      const plan = { taskId: ctx.taskId, steps, revision: (previous?.revision ?? 0) + 1 };
      await deps.plan.save(ctx.key, plan);
      return textResult(formatPlan(plan));
    },
  });
}

function planUpdateStep(deps: BuiltinToolDeps): Tool {
  return defineTool({
    id: 'plan_update_step',
    description: t('tool.plan-update.description'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: { enum: [...STATUSES] },
        output: { type: 'string' },
      },
      required: ['name', 'status'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args, ctx) => {
      const fields = isJsonObject(args) ? args : {};
      const name = text(fields['name']);
      const status = fields['status'];
      const plan = await deps.plan.load(ctx.taskId);
      if (plan === undefined) {
        return errorResult('no-plan', t('tool.plan-update.no-plan'));
      }
      if (!isStatus(status) || !plan.steps.some((step: PlanStep) => step.name === name)) {
        return errorResult('unknown-step', t('tool.plan-update.unknown-step', { name }));
      }
      const output = fields['output'];
      const steps = plan.steps.map((step: PlanStep) =>
        step.name === name
          ? { ...step, status, output: typeof output === 'string' ? output : step.output }
          : step,
      );
      const updated = { ...plan, steps, revision: plan.revision + 1 };
      await deps.plan.save(ctx.key, updated);
      return textResult(formatPlan(updated));
    },
  });
}

function schemaProblem(deps: BuiltinToolDeps, name: string, value: Json): string | null {
  for (const [prefix, schema] of deps.stateSchemas ?? []) {
    if (name.startsWith(prefix)) {
      const outcome = new Validator(schema, '2020-12', true).validate(value);
      if (!outcome.valid) {
        return outcome.errors.at(-1)?.error ?? '';
      }
    }
  }
  return null;
}

function stateTools(deps: BuiltinToolDeps): Tool[] {
  const get = defineTool({
    id: 'state_get',
    description: t('tool.state-get.description'),
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args, ctx) => {
      const name = text(isJsonObject(args) ? args['name'] : undefined);
      const value = await deps.state.get(ctx.taskId, name);
      return value === undefined
        ? errorResult('not-found', t('tool.state-get.missing', { name }))
        : { ok: true, content: [{ type: 'text', text: JSON.stringify(value) }], structured: value };
    },
  });
  const set = defineTool({
    id: 'state_set',
    description: t('tool.state-set.description'),
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 }, value: {} },
      required: ['name', 'value'],
      additionalProperties: false,
    },
    retrySafe: true,
    invoke: async (args, ctx) => {
      const fields = isJsonObject(args) ? args : {};
      const name = text(fields['name']);
      const value = fields['value'] ?? null;
      if (name.startsWith('yaah.')) {
        return errorResult('reserved', t('tool.state-set.reserved'));
      }
      const reason = schemaProblem(deps, name, value);
      if (reason !== null) {
        return errorResult('invalid-value', t('tool.state-set.invalid', { name, reason }));
      }
      await deps.state.set(ctx.taskId, ctx.key, name, value);
      return textResult(t('tool.state-set.stored', { name }));
    },
  });
  return [get, set];
}

/** The built-in tools, ready to register. */
export function createBuiltinTools(deps: BuiltinToolDeps): Tool[] {
  return [askUser(), planSet(deps), planUpdateStep(deps), ...stateTools(deps)];
}
