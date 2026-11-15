import type { Entity } from '../../kernel/entity.ts';
import { LOCAL } from '../../kernel/entity.ts';
import { PromptVariableError } from '../../kernel/errors.ts';
import type { EntityRegistry } from '../../kernel/registry.ts';

declare module '../../kernel/entity.ts' {
  interface EntityMap {
    prompt: Prompt;
  }
}

/**
 * A prompt, or a fragment of one, sent to a model.
 *
 * Invariant: every piece of text yaah sends to a model as instructions is a `Prompt`
 * entity whose source is a markdown file — never a string assembled in code.
 */
export interface Prompt extends Entity<'prompt'> {
  /** Markdown source, with `{{name}}` placeholders. */
  readonly template: string;
  /** The placeholder names used by `template`, in order of first use. */
  readonly variables: readonly string[];
  /** The id of the prompt this one is appended to, or null when it stands alone. */
  readonly extends: string | null;
  /**
   * Fills the placeholders.
   *
   * @throws PromptVariableError when a declared variable has no value.
   */
  render(vars: Readonly<Record<string, string>>): string;
}

/** What {@link definePrompt} needs. */
export interface PromptDefinition {
  readonly id: string;
  readonly template: string;
  readonly version?: string;
  readonly description?: string;
  /** Append this prompt to the prompt with this id instead of using it on its own. */
  readonly extends?: string;
}

const VARIABLE = /\{\{\s*(\w+)\s*\}\}/gu;

/** Builds a local prompt entity from markdown source. */
export function definePrompt(definition: PromptDefinition): Prompt {
  const variables = [
    ...new Set(Array.from(definition.template.matchAll(VARIABLE), (match) => match[1] ?? '')),
  ];
  return {
    ref: { kind: 'prompt', id: definition.id, version: definition.version ?? null },
    description: definition.description ?? '',
    locality: LOCAL,
    template: definition.template,
    variables,
    extends: definition.extends ?? null,
    render(vars: Readonly<Record<string, string>>): string {
      return definition.template.replaceAll(VARIABLE, (_whole: string, name: string) => {
        const value = vars[name];
        if (value === undefined) {
          throw new PromptVariableError(definition.id, name);
        }
        return value;
      });
    },
  };
}

/**
 * Renders the prompt `id` followed by every registered prompt that extends it, separated
 * by blank lines. Extensions are appended in id order, which keeps the output stable
 * from one call to the next.
 *
 * @throws EntityNotFoundError when no prompt `id` is registered.
 * @throws PromptVariableError when a variable is missing.
 */
export function renderPrompt(
  registry: EntityRegistry,
  id: string,
  vars: Readonly<Record<string, string>>,
): string {
  const base = registry.resolve({ kind: 'prompt', id, version: null });
  const extensions = registry.list('prompt').filter((prompt: Prompt) => prompt.extends === id);
  return [base, ...extensions].map((prompt: Prompt) => prompt.render(vars).trim()).join('\n\n');
}
