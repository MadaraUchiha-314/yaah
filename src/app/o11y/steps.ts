/**
 * How each step of the core loop appears in the log and in a trace: which record type it
 * is, what its span is called, and which of its inputs and outputs are worth recording.
 * Only names, ids and counts are read here — never content.
 */
import type { StepCall } from '../../harness/core/step-middleware.ts';
import type { StepName } from '../../harness/core/step-runner.ts';
import type { RecordType } from './logger.ts';

/** The tool through which the model calls another agent. */
const INVOKE_AGENT = 'invoke_agent';

/** Names, ids and counts of one step. */
export type StepFacts = Readonly<Record<string, string | number | boolean | undefined>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function toolName(call: StepCall): string | undefined {
  return text(field(field(call.input, 'call'), 'name'));
}

function agentId(call: StepCall): string | undefined {
  return text(field(field(field(call.input, 'call'), 'args'), 'agent'));
}

const RECORD_TYPE: Readonly<Record<StepName, RecordType>> = {
  'conversation.accept': 'state.written',
  'context.build': 'context.built',
  'context.compact': 'context.compacted',
  'llm.invoke': 'llm.invoked',
  'tool.invoke': 'tool.invoked',
  'task.transition': 'task.transition',
};

/** The record type a step is logged as. */
export function recordTypeOf(call: StepCall): RecordType {
  return toolName(call) === INVOKE_AGENT ? 'agent.invoked' : RECORD_TYPE[call.name];
}

/** The span name of a step, by the GenAI semantic conventions where one applies. */
export function spanNameOf(call: StepCall, model: string): string {
  if (call.name === 'llm.invoke') {
    return `chat ${model}`;
  }
  if (call.name === 'tool.invoke') {
    const tool = toolName(call) ?? 'unknown';
    return tool === INVOKE_AGENT
      ? `invoke_agent ${agentId(call) ?? 'unknown'}`
      : `execute_tool ${tool}`;
  }
  return call.name;
}

/** What is known about a step before it runs, as span attributes. */
export function startFacts(call: StepCall, model: string): StepFacts {
  if (call.name === 'llm.invoke') {
    return { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': model };
  }
  if (call.name === 'tool.invoke') {
    const tool = toolName(call);
    const callId = text(field(field(call.input, 'call'), 'id'));
    return tool === INVOKE_AGENT
      ? { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': agentId(call) }
      : {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': tool,
          'gen_ai.tool.call.id': callId,
        };
  }
  if (call.name === 'task.transition') {
    return { 'yaah.transition.reason': text(field(call.input, 'reason')) };
  }
  return {};
}

const END_FACTS: Readonly<Record<StepName, (output: unknown) => StepFacts>> = {
  'llm.invoke': (output: unknown): StepFacts => {
    const usage = field(output, 'usage');
    const calls = field(output, 'toolCalls');
    return {
      'gen_ai.usage.input_tokens': count(field(usage, 'inputTokens')),
      'gen_ai.usage.output_tokens': count(field(usage, 'outputTokens')),
      'yaah.tool_calls': Array.isArray(calls) ? calls.length : undefined,
    };
  },
  'tool.invoke': (output: unknown): StepFacts => {
    const ok = field(output, 'ok');
    return { 'yaah.tool.ok': typeof ok === 'boolean' ? ok : undefined };
  },
  'task.transition': (output: unknown): StepFacts => ({
    'yaah.task.state': text(field(output, 'state')),
  }),
  'context.build': (output: unknown): StepFacts => ({
    'yaah.context.estimated_tokens': count(field(output, 'estimatedTokens')),
  }),
  'context.compact': (output: unknown): StepFacts => ({
    'yaah.context.tokens_before': count(field(output, 'before')),
    'yaah.context.tokens_after': count(field(output, 'after')),
  }),
  'conversation.accept': (output: unknown): StepFacts => ({
    'yaah.inbox.accepted': count(field(output, 'accepted')),
  }),
};

/** What a finished step's output adds, as span attributes. */
export function endFacts(call: StepCall, output: unknown): StepFacts {
  return END_FACTS[call.name](output);
}

/** The same facts under the short names a log record uses. */
export function logFacts(facts: StepFacts): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== undefined) {
      const short = key.replace(/^(?:gen_ai|yaah)\./u, '');
      fields[short.replaceAll(/[._]([a-z])/gu, (_: string, c: string) => c.toUpperCase())] = value;
    }
  }
  return fields;
}
