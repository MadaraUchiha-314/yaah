/**
 * yaah — Yet Another Agent Harness.
 *
 * The package's public entry point. Everything the `yaah` command uses is exported, so a
 * developer can build the same harness programmatically with {@link createHarness}.
 */
export * from './kernel/index.ts';
export { definePrompt, renderPrompt } from './harness/system-prompt/prompt.ts';
export type { Prompt, PromptDefinition } from './harness/system-prompt/prompt.ts';
