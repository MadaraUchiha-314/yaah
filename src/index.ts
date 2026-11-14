/**
 * yaah — Yet Another Agent Harness.
 *
 * The package's public entry point. Everything the `yaah` command uses is exported, so a
 * developer can build the same harness programmatically with {@link createHarness}. Each
 * directory of the source tree is also a subpath (`@yaah/yaah/kernel`,
 * `@yaah/yaah/harness/core`, `@yaah/yaah/testing`, …); plugins are named by their subpath
 * in a composition.
 */
export * from './kernel/index.ts';
export { runCli } from './cli/main.ts';
export type { CliIo } from './cli/main.ts';
export type * from './harness/core/types.ts';
export * from './harness/models/llm/index.ts';
export { definePrompt, renderPrompt } from './harness/system-prompt/prompt.ts';
export type { Prompt, PromptDefinition } from './harness/system-prompt/prompt.ts';
export * from './harness/tools/index.ts';
export * from './surface/index.ts';
