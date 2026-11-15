---
type: evidence
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Final validation: yaah — Yet Another Agent Harness

> The `evidence` node's proof: what is presented to the user to show the acceptance
> criteria are met. **Summarised from the executed verification** — `testing-plan.md`'s
> Verification results — and mapped onto the acceptance criteria rather than re-derived.
> Raw captures (output, screenshots, recordings) sit beside this file under `evidence/`.

**State at the time of writing:** branch `issue-3-8-extensibility`, commit `821ac62`
(pull requests #7–#13, stacked). Every suite was run on the code after the last review
fix (`2313500`); later commits change documentation only.

| Suite | Result |
| --- | --- |
| `bun run check` (format, lint, typecheck, 1195 tests with per-file coverage ≥ 90%, build, built package on Node) | pass |
| `bun run test:node` | 1126 pass |
| `bun run test:e2e` (web chat, terminal chat on a pty, browser build; axe) | 47 pass |
| `bun run test:chaos` (`SIGKILL` mid-tool; in-process, embedded Temporal, Temporal Cloud) | 6 pass |
| `bun run test:live` (Claude and GPT 6.1; in process, embedded Temporal, Temporal Cloud; an image turn) | 5 pass |
| CI on `2313500` (Bun; Node 22 and 24; commitlint) | all green |

The "Scenarios" column counts Gherkin scenarios whose `Requirement:` line cites the
requirement (`the-loop scenarios --glob 'test/**/*.ts'`, 235 in all; full list in
[`integration.md`](integration.md)). A scenario can cite several requirements.

## Final validation evidence

| Acceptance criterion | How it was proved | Where |
|----------------------|-------------------|-------|
| **R1** Plugin kernel and composition | 11 scenarios: a composition includes shared files, replaces or reconfigures a plugin by id, a plugin that fails to load stops start-up and is named, an override for an entry that does not exist stops start-up, disposing a plugin removes what it registered | `test/integration/composition.test.ts`, [`integration.md`](integration.md) |
| **R2** Entity model and registry | Unit tests of the registry (register, resolve by `(kind, id, version)`, conflicts, disposal) and every entity kind passing its contract suite (LLM, persistence, durable, System One, speech, renderer) | `src/kernel/registry.test.ts`, [`contract.md`](contract.md) |
| **R3** Core loop | 8 scenarios (a turn of model and tools, parallel tool calls, interrupts, unregistered tools refused); the durable contract runs the loop on both runners | [`integration.md`](integration.md), [`contract.md`](contract.md) |
| **R4** Task, plan and step | Plan unit tests (DAG validation); scenarios linking sub-tasks and tasks created for participants | `src/harness/core/plan.test.ts`, [`integration.md`](integration.md) |
| **R5** State and persistence | Persistence contract on memory and SQLite; state and plan restored after a restart | [`contract.md`](contract.md), `test/integration/restart.test.ts` |
| **R6** Context window manager and compaction | 6 scenarios: oversized conversations compacted before the model call, small ones left alone; live two-turn task on real models | `test/integration/compaction.test.ts`, [`demo.md`](demo.md) |
| **R7** Models: LLM and System One | LLM contract on OpenAI (recorded from `gpt-6.1-sol`), Anthropic (recorded), OpenAI-compatible (recorded); System One contract; triage on and off; live suite on Claude and GPT 6.1 | [`contract.md`](contract.md), `test/live/providers.test.ts` |
| **R8** Tools and MCP | 10 scenarios: stdio and HTTP MCP servers, failing tools reported, non-idempotent tools run once per call, unreachable servers retried | `test/integration/mcp.test.ts` |
| **R9** Skills, agent plugins and hooks (P1) | 18 scenarios: skills loaded only when used, path escapes refused, agent plugins register skills and MCP servers, hooks deny tool calls, messages and sub-agents; a plugin with a bad manifest refused by rule | `test/integration/{skills,plugins,hooks}.test.ts`, [`security-tests.md`](security-tests.md) |
| **R10** System prompt and strings | Prompt rendering and override unit tests; strings fall back to `en`; participants and roles shown to the model | `src/harness/system-prompt/prompt.test.ts`, `src/kernel/strings.test.ts` |
| **R11** Sub-agents over A2A | 7 scenarios: loopback and remote agents, depth limit, failed sub-tasks reported, card hosts checked | `test/integration/sub-agents*.test.ts` |
| **R12** Participants and channels (P1) | 6 scenarios: a non-participant rejected, a quick question returns the reply, a task created for a participant, membership changed only by the harness | `test/integration/channels.test.ts` |
| **R13** A2A API server | 11 scenarios over JSON-RPC and HTTP+JSON; the agent card lists what plugins add after start; malformed and empty requests create no task | `test/integration/a2a-server.test.ts` |
| **R14** Task lifecycle and long-running tasks | 28 scenarios: input-required with sub-state, complete and cancel (also after a restart), ask-for-input; the definition-of-done demo | `test/integration/{a2a-lifecycle,task-lifecycle,session}.test.ts`, [`demo.md`](demo.md) |
| **R15** Inbox and events | 18 scenarios: stored before delivered, exactly-once across retries and restarts, interrupts, forged events discarded; crash recovery | `test/integration/inbox-events.test.ts`, [`chaos.md`](chaos.md) |
| **R16** Heartbeat (P1) | Stalled task reported once; untaken inbox items handed back | `test/integration/heartbeat.test.ts` |
| **R17** Durable execution | 14 scenarios plus crash recovery by `SIGKILL` in all three modes, including Temporal Cloud `yaah.gtebu`; the dashboard link shown in both chats | [`chaos.md`](chaos.md), `test/integration/temporal.test.ts` |
| **R18** Observability (Langfuse P1) | 13 scenarios: every step logged with task and trace ids, one trace across A2A, model and tool, a caller's trace continued, credentials in no log, span or Temporal failure; Langfuse preset headers | `test/integration/observability.test.ts`, `test/security/credential-leak.test.ts` |
| **R19** Surfaces and renderers | 20 scenarios; both renderers pass one renderer contract; A2UI forms drawn and round-tripped; hostile A2UI falls back to text | [`e2e.md`](e2e.md), [`contract.md`](contract.md) |
| **R20** Web renderer | 21 scenarios incl. Playwright in Chromium; axe finds no serious or critical violation in any state, light and dark; keyboard-only flow; 400 px | [`e2e.md`](e2e.md), [`ui/`](ui/) |
| **R21** TUI renderer | 12 scenarios incl. a whole conversation on a real pseudo-terminal; escape sequences neutralised; plain mode without a TTY | [`e2e.md`](e2e.md), [`ui/`](ui/) |
| **R22** CLI, SDK and configuration | 9 scenarios: `yaah`, `yaah serve`, `yaah tui --url --attach`, `--config`; invalid configuration names file, key and reason; the built package runs on Node; export list is a contract | `test/integration/cli.test.ts`, `test/package/built.test.ts` |
| **R23** Commands | 11 scenarios: commands never reach the model, change the task, are highlighted in both chats | `test/integration/commands.test.ts` |
| **R24** Multi-modal input, output and voice (P1) | 22 scenarios: images to models that accept them, refusal otherwise, generated images as artifacts, audio transcribed, speech streamed before the final event, microphone denied or missing; a live image turn on Claude | `test/integration/{modalities,voice}.test.ts`, `test/e2e/web-voice*.spec.ts` |
| **R25** Browser build (P1) | 12 scenarios: a multi-turn task in Chromium from static files with no server; a node-only plugin fails the build by name | `test/e2e/browser-build.spec.ts`, `test/integration/browser-build.test.ts` |
| **R26** Engineering quality | Strict TypeScript, pedantic lint with warnings as errors, per-file coverage ≥ 90%, tests on Bun and Node 22/24/26, published contracts under `specs/` held by tests | `bun run check`, [`runtimes.md`](runtimes.md), [`unit.md`](unit.md) |
| **R27** Definition-of-done demo | Recorded on OpenAI GPT 6.1 with Temporal Cloud `yaah.gtebu`, and again on embedded Temporal: web and terminal chat on one task, A2UI form, ask-for-input answered from the other chat, `/model`, complete; workflow history | [`demo.md`](demo.md), [`demo/`](demo/) |
| **Security considerations** — 12 abuse cases and the fail-closed rules | A green negative test per abuse case and per fail-closed rule; 38 security-tagged scenarios; security review with a named sign-off | [`security-tests.md`](security-tests.md), [`security-review.md`](security-review.md) |

## Not met, or met with a caveat

| Item | State |
| --- | --- |
| R27.6 — the Temporal Web UI open on Temporal Cloud | The Cloud web UI needs a signed-in browser. The link is shown in both chats and the workflow history was read through the API; the UI screenshot is from the embedded run. |
| R24 — OpenAI transcription, Realtime speech, image generation | Built against the documented API and hand-written fixtures; not called live. No real microphone or speaker used. |
| R7.5 — System One on the Decisions API | Built against the documentation and SDK types with hand-written fixtures; not called live. |
| R18.5 — Langfuse | Exercised against a local OTLP collector, not the Langfuse service. |
| A refused Realtime handshake | Reported as retryable: no runtime exposes the HTTP status of a refused WebSocket upgrade. Won't-fix in this work item (self-review 2, #18). |
| Reviews | Two self-review rounds and one critic round (60 findings: 59 fixed, 1 won't-fix) — [`self-review.md`](self-review.md), [`critic-review.md`](critic-review.md). |
