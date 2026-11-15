# Security tests (T8)

Run on 2026-11-14 at commit `b3deea5`. `bun run test:security`: 11 pass, 0 fail (4 files).
The negative tests for the twelve abuse cases are not all in `test/security/`: several
live with the feature they guard. Every test named here ran green in `bun run test`
(1084 pass) or `bun run test:e2e` (47 pass).

| # | Abuse case | Negative test | Where |
| --- | --- | --- | --- |
| 1 | Default bind | The harness listens on loopback unless told otherwise | `test/security/network.test.ts` |
| 2 | Foreign `Origin` | A browser request from a foreign origin is rejected; the harness's own origin and an allowed origin may call | `test/security/network.test.ts` |
| 3 | Unregistered tool or agent | An unregistered tool is refused and reported to the model; a tool outside the allowed set; a tool with no input schema is never called | `test/integration/core-loop.test.ts`, `src/harness/tools/execute.test.ts` |
| 4 | Injected instructions | Instructions inside a tool result grant nothing | `test/security/abuse-cases.test.ts` |
| 5 | Hostile A2UI | A hostile A2UI surface falls back to text (unknown component, `javascript:` URL — nothing executed) | `test/e2e/web.spec.ts`; terminal: `src/surface/renderer/tui/components.test.ts` |
| 6 | Terminal escapes | Terminal escape sequences in a reply are neutralised; the filter's unit tests (OSC title, cursor movement, clear screen, hyperlinks) | `test/integration/tui.test.ts`, `src/surface/renderer/tui/filter.test.ts` |
| 7 | Runtime URL fetch | A URL in a message is never fetched; a card pointing at a host that was not allowed is refused | `test/security/abuse-cases.test.ts`, `test/integration/sub-agents-unavailable.test.ts` |
| 8 | Oversized or flooding request | An oversized or flooding request is rejected before any model call; a part over the size limit is refused before a task exists; a message that says nothing is refused | `test/security/network.test.ts`, `test/integration/modalities.test.ts`, `test/integration/exploratory-findings.test.ts` |
| 9 | Runaway recursion, loop or spend | Delegation past the depth limit is refused; the iteration limit fails the task; the task token budget fails the task before the next model call | `test/integration/sub-agents.test.ts`, `test/integration/core-loop.test.ts` |
| 10 | Forged inbox event | A forged inbox event is discarded; a message from a non-participant is rejected | `test/integration/inbox-events.test.ts`, `test/integration/channels.test.ts` |
| 11 | Path escape | A skill symlinked from outside its root is not registered; `read_skill_file` cannot leave the skill directory; `resolveInside` unit tests | `test/security/skill-paths.test.ts`, `src/kernel/paths.test.ts` |
| 12 | Credential leak | A credential that surfaces in an error or a tool result leaves by no exit (log, spans, the client's stream, the next model request) | `test/security/credential-leak.test.ts` |

## Fail closed

| Rule | Test | Where |
| --- | --- | --- |
| Non-loopback bind states that the API is unauthenticated | A non-loopback bind is announced as unauthenticated | `test/security/network.test.ts` |
| Missing credential: the entity is not registered; start fails if it is required | refuses to start without a key when the model is that provider's | `src/harness/models/llm/anthropic/index.test.ts`, `test/integration/llm-openai-plugins.test.ts`, `test/integration/langfuse.test.ts` |
| Unknown configuration key | an unknown key is an error naming the file and the key | `src/kernel/config.test.ts` |
| Invalid composition; a plugin that fails to load | a plugin that fails to load, or cannot be found, stops start-up and is named | `test/integration/composition.test.ts` |
| Invalid skill or plugin package | refused, naming the rule | `test/integration/skills.test.ts`, `test/integration/plugins.test.ts` |
| Remote Temporal unreachable | Unreachable remote Temporal stops start-up | `test/integration/temporal.test.ts` |
| Tool with no schema, or arguments that fail it | the call is not made | `src/harness/tools/execute.test.ts` |
| A hook that throws, times out or answers nonsense | counts as deny | `src/harness/hooks/service.test.ts`, `src/harness/plugins/mcp-hook.test.ts` |
