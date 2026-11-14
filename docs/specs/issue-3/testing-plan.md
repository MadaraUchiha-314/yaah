---
type: testing-plan
phase: test-planning
workItem: "issue-3"
status: approved
approvedBy: ["MadaraUchiha-314"]
overrides: {}
---

# Testing plan: yaah — Yet Another Agent Harness

> Derived from the approved [`requirements.md`](requirements.md) and from
> [`design.md`](design.md), **before** `tasks.md` — each task's `_Test:_` names a row of
> the matrix below. Authored at the `test-planning` node and **completed at the
> `verification` node**.
>
> **This file is executable content.** It names commands an agent will run, so review it
> like code. Credentials appear **by reference only**.

The harness is proved in two layers. Everything that can be deterministic is: a
**scripted LLM** replays fixed model events, so the loop, the A2A surface, durability,
both UIs and every abuse case run with no network and no credential, on every commit.
What only a real provider can show — GPT 6.1 driving tools, Temporal Cloud surviving a
killed process — runs in a separate **live** suite that produces the definition-of-done
evidence.

**What it costs.** Three test dependencies are added: Playwright (web end-to-end,
visual and accessibility), `@axe-core/playwright`, and `ink-testing-library`. The live
suite spends real tokens (budgeted under 2 USD per run) and needs three credentials.

**What to check first.** T12 and T13 — the live demo and the crash test — because they
are the only rows that can fail for reasons outside the repository.

## Test matrix

| # | Type | Applies? | Scope / what it proves | Where it runs |
| --- | --- | --- | --- | --- |
| T1 | Unit | yes | Pure logic: plan DAG validation, compaction selection, section hashing and byte stability, config parsing, step keys, the redactor, the terminal filter, extension schemas, the task-state table. | `bun run test:unit` |
| T2 | Integration (scenario) | yes | A real server driven through the A2A SDK client with the scripted LLM, a stub MCP server and a second in-process agent. Every scenario has a Gherkin docstring. | `bun run test:integration` |
| T3 | Contract | yes | (a) Entity contract suites — `llmContract`, `toolContract`, `persistenceContract`, `durableContract`, `systemOneContract`, `rendererContract` — run against every shipped implementation. (b) Checked-in JSON Schemas under `specs/a2a-extensions/` and `specs/config/` equal the schemas regenerated from source. (c) The package's public export list equals `specs/api/exports.json`. No OpenAPI or GraphQL: yaah's HTTP API is A2A, whose contract belongs to the A2A specification and is exercised through the official SDK client in T2. | `bun run test:contract` |
| T4 | End-to-end | yes | The built package, started with `yaah serve`, driven in a real browser; and the `yaah` TUI driven through a pseudo-terminal. Scripted LLM. | `bun run test:e2e` |
| T5 | UI / visual | yes | Screenshots of each state in the design prototypes, web (light, dark, 400 px) and TUI (colour, no colour), compared by eye against `design/` at verification. | `bun run test:e2e -- --update-evidence` |
| T6 | Snapshot | yes | Rendered context for a fixed conversation (catches prompt and ordering drift); TUI frames; agent card; default `config.toml`. | `bun run test:unit` (snapshot files beside tests) |
| T7 | Performance / load | n/a — the requirements set no throughput or latency target beyond "first token is streamed, not buffered", which T2 asserts by ordering (a delta arrives before the final event). A load test would measure the provider, not yaah. | | |
| T8 | Security / abuse case | yes | One negative test per abuse case 1–12 and per fail-closed rule, as listed in `design.md` § Security design. | `bun run test:security` |
| T9 | Accessibility | yes | axe-core on each web state (no serious or critical violations); keyboard-only run of the send → form → complete flow; contrast of both themes. TUI: the no-colour, non-TTY path. | `bun run test:e2e -- --grep @a11y` |
| T10 | Migration / upgrade | n/a — first release; there is no earlier version, schema or stored data to migrate. | | |
| T11 | Manual exploratory | yes | 30 minutes with the live harness in both UIs, trying to break turn-taking: interrupt mid-tool, cancel while idle, two surfaces typing at once, malformed commands. Findings are recorded, and each real defect becomes a T2 scenario before it is fixed. | by hand, notes in `evidence/exploratory.md` |
| T12 | Live demo (definition of done) | yes | R27: one harness, both UIs, A2UI, multi-turn, ask-for-input, OpenAI `gpt-6.1-sol`, Temporal Cloud namespace `yaah.gtebu`, dashboard open. | `bun run test:live` then `bun run demo:record` |
| T13 | Crash recovery (chaos) | yes | Kill the harness process with `SIGKILL` mid-tool and mid-LLM-call; restart; the task finishes and no recorded step runs twice. In-process journal, embedded Temporal, Temporal Cloud. | `bun run test:chaos` |
| T14 | Cross-runtime | yes | T1–T3 and T8 on Bun 1.4 and on Node 22 and 24; T13 embedded on both. | CI matrix; locally `bun run test` and `bun run test:node` |
| T15 | Internationalisation | yes | A second locale file with one key missing: present keys are used, the missing one falls back to `en`; no user-visible literal in source (lint rule plus bundle scan). | `bun run test:unit` |

`bun run test` runs T1, T2, T3, T6, T8 and T15 and stays what the pre-commit hook and CI
run. T4, T5, T9 and T13 run in CI as a second job; T12 runs only where the credentials
exist.

## Scenarios & requirement trace

| Row | Requirement(s) | Scenario / case |
| --- | --- | --- |
| T1 | R4.3–4.4 | Plan with a cycle, an unknown dependency, a duplicate name → rejected with the reason. |
| T1 | R6.1–6.4 | Section order fixed; an unchanged section is byte-identical across two builds; compaction never selects sections 1–5, an unanswered tool call or a pinned message. |
| T1 | R5.2, R10.4–10.5, R22.3–22.5 | State schema rejection; string fallback; config defaults, `--config` precedence, unknown key error naming file and key. |
| T1 | R2.2, R2.5–2.6 | `(id, null)` resolves; unknown ref → typed not-found; duplicate registration rejected unless `override`. |
| T2 | R1.1–1.5 | `Scenario: A composition replaces a default plugin by id` · `Scenario: A plugin that fails to load stops start-up and is named` · `Scenario: Disposing a plugin removes its tools and commands` |
| T2 | R3.2–3.6 | `Scenario: Parallel tool calls return in order` · `Scenario: One failed tool call does not lose the others` · `Scenario: The iteration limit fails the task` · `Scenario: Cancel stops a working task` |
| T2 | R14.1–14.8 | `Scenario: A response completes a task by default` · `Scenario: A long-running task stays open across turns` · `Scenario: The agent asks for input and continues on the reply` · `Scenario: A client completes an open task` · `Scenario: A client cancels an idle open task` · `Scenario: A message to a completed task is rejected` · `Scenario: A sub-task ignores the long-running request` |
| T2 | R13.1–13.5 | `Scenario: Every A2A operation answers over JSON-RPC and HTTP+JSON` · `Scenario: The agent card lists every yaah extension` · `Scenario: A required unsupported extension is rejected` · `Scenario: A malformed request creates no task` |
| T2 | R15.1–15.6 | `Scenario: An inbox item survives a restart` · `Scenario: A message during tool execution is read at the next iteration` · `Scenario: An interrupting item aborts the current iteration` · `Scenario: A redelivered item is consumed once` · `Scenario: A sub-task status event is accepted as inbox input` |
| T2 | R11.1–11.7, R4.5–4.6 | `Scenario: A sub-agent call links a sub-task` · `Scenario: A loopback sub-agent gets a fresh context` · `Scenario: A failed sub-task is reported to the model` · `Scenario: Delegation past the depth limit is refused` |
| T2 | R5.3–5.4, R17.1–17.7 | `Scenario: State and plan are restored after a restart` · `Scenario: A retryable step is retried with backoff` · `Scenario: A tool not marked safe is not retried` · `Scenario: Unreachable remote Temporal stops start-up` |
| T2 | R17.8–17.10 | `Scenario: The Temporal Web UI address is printed and in the agent card` · `Scenario: A task carries a link to its workflow` · `Scenario: Embedded mode serves the Temporal Web UI` |
| T2 | R7.3–7.4, R8.1–8.5 | `Scenario: MCP tools are registered from a configured server` · `Scenario: Invalid tool arguments are refused before the call` · `Scenario: An unreachable MCP server does not stop start-up` · `Scenario: A provider error names provider and model` |
| T2 | R19.3–19.6, R23.1–23.5 | `Scenario: Two surfaces follow one task` · `Scenario: A basic-catalog A2UI form round-trips an action` · `Scenario: An unknown A2UI component falls back to text` · `Scenario: A command never reaches the model` · `Scenario: An unknown command is reported` |
| T2 | R18.1–18.4 | `Scenario: Every step of a task is logged with task and trace ids` · `Scenario: One trace spans the A2A call, the model call and the tool call` |
| T2 (P1) | R9, R12, R16, R24, R25 | `Scenario: A skill body is loaded only when used` · `Scenario: An agent plugin registers its skills and MCP servers` · `Scenario: A hook denies a tool call` · `Scenario: A message from a non-participant is rejected` · `Scenario: The heartbeat reports a stalled task` · `Scenario: An audio turn is transcribed for a text-only model` · `Scenario: The browser build completes a multi-turn task without a server` |
| T3 | R2.1, R2.3, R7.1–7.3, R26.6 | Each contract suite, per implementation; schema and export-list equality. |
| T4, T5 | R20.1–20.5, R21.1–21.3, R22.1–22.2 | Web: send, stream, form, input request, complete, cancel, command highlight. TUI: the same, plus `/exit` restores the terminal and the non-TTY path. |
| T6 | R6.2, R13.2, R22.3 | Rendered-context, agent-card and default-config snapshots. |
| T8 | Abuse cases 1–12; fail-closed list | `Scenario: <abuse case title>` — the twelve negative tests in the design's coverage table, plus: missing credential, invalid `cordis.yaml`, tool without a schema. |
| T9 | R20.6, R21.2 | axe run per state; keyboard-only flow; non-TTY output. |
| T12 | R27.1–27.7, R7.1, R17.1 | The demo script below. |
| T13 | R15.6, R17.3–17.5 | `Scenario: A crashed run resumes without repeating a recorded step`, three modes. |
| T14 | Non-functional: runtime | The suites above on each runtime. |
| T15 | R10.4–10.5 | Locale fallback; no literals. |

## Verification environment

- **Repositories:** this repository only.
- **Services / containers:**
  - None for T1–T11, T14, T15. The stub MCP server, the second agent and the scripted LLM
    are test fixtures started in-process.
  - Embedded Temporal (T2 durable scenarios, T13): started by the harness itself through
    `@temporalio/testing`, which downloads the Temporal CLI on first use (about 125 MB,
    cached). Needs outbound HTTPS once.
  - Temporal Cloud (T12, T13 remote): namespace `yaah.gtebu`, address
    `yaah.gtebu.tmprl.cloud:7233`. If API-key authentication is refused on the namespace
    endpoint, the regional endpoint is used instead and recorded.
  - A browser for T4, T5, T9: `bunx playwright install chromium`.
- **Fixtures & data:** scripted model transcripts under `test/fixtures/llm/`; a stub MCP
  server with `lookup_order`, `refund_rules` and a deliberately slow, non-idempotent
  `refund`; a sample skill and a sample agent plugin; the A2UI refund form used in the
  design prototypes.
- **Credentials:** **by reference only.**
  - `OPENAI_API_KEY` — or `secret-tool lookup service openai project yaah`
  - `TEMPORAL_API_KEY` — or `secret-tool lookup service temporal project yaah`
  - `ANTHROPIC_API_KEY` — or `secret-tool lookup service anthropic project yaah` (the
    Anthropic provider's contract suite only; at the time of writing the variable is
    not set in this environment, so the keyring is the source)
- **Bring-up:** `bun install && bun run build` · for the live rows,
  `bun run demo:up` (starts `yaah serve` with `durable.mode = "temporal-remote"` and
  prints the harness and dashboard addresses).
  **Tear-down:** `bun run demo:down`.
- **If bring-up fails:** record it under Verification results, leave the dependent
  activities unticked, and escalate — do not pass the gate on an environment that never
  came up. A live row skipped for a missing credential is **not** a pass.

### The demo script (T12)

One harness, model `openai/gpt-6.1-sol`, Temporal Cloud, the stub MCP server.

1. Start the harness. Capture the start-up output showing the Temporal Web UI address;
   open it.
2. Web: start a long-running task — "Order A-1041 arrived damaged. Can I get a refund?"
   Expect two tool calls in parallel, then an A2UI form. Submit it.
3. The agent asks for a judgement call (refund above the auto-approval limit). The task
   shows `input-required`.
4. TUI, attached to the same harness with `yaah tui --url`: the task is listed; follow
   it; answer the question from the terminal. The web UI shows the answer and the
   continued response.
5. TUI: `/model` and one more turn. Web: complete the task. Both UIs show it completed.
6. In the Temporal Web UI, open the task's workflow from the link the UI shows; capture
   its history.

## Evidence plan

| Row | Evidence | Path under `evidence/` |
| --- | --- | --- |
| T1, T6, T15 | Test summary and coverage table | `unit.md` |
| T2 | `the-loop scenarios --format markdown` table and run output | `integration.md` |
| T3 | Contract suite output; schema diff result | `contract.md` |
| T4, T5, T9 | Run output; screenshots per state; one GIF per UI of the send → form → input → complete flow | `e2e.md`, `ui/web-<state>-<theme>.png`, `ui/tui-<state>.png`, `ui/web-flow.gif`, `ui/tui-flow.gif` |
| T8 | One section per abuse case: the test name and its output | `security-tests.md` |
| T11 | Notes, findings and what became of each | `exploratory.md` |
| T12 | Start-up output, the transcript of both UIs, screenshots of each demo step including the Temporal Web UI, a GIF of the two UIs side by side, and the red → green record for the first scenario | `demo.md`, `demo/*.png`, `demo/demo.gif` |
| T13 | Per mode: the kill point, the step journal or workflow history before and after, and the call counts of the stub tools | `chaos.md` |
| T14 | Runtime versions and summaries per runtime | `runtimes.md` |

Redaction before commit: API keys and bearer headers (the test harness fails a run
whose captured output contains a configured credential), the Temporal account id in
URLs if it differs from the public namespace name, and local user paths. Screenshots of
the Temporal Web UI are checked by eye for account e-mail addresses.

GIFs: the web flow is a Playwright video converted with `ffmpeg`; the TUI flow is
recorded as terminal frames, rendered to images in headless Chromium and assembled with
`ffmpeg`.

## Verification activities

- [ ] T1 — `bun run test:unit`
- [ ] T2 — `bun run test:integration`
- [ ] T3 — `bun run test:contract`
- [ ] T4 — `bun run test:e2e`
- [ ] T5 — `bun run test:e2e -- --update-evidence`, then compare with `design/`
- [ ] T6 — `bun run test:unit` (snapshots unchanged)
- [ ] T8 — `bun run test:security`
- [ ] T9 — `bun run test:e2e -- --grep @a11y`
- [ ] T11 — exploratory session, notes recorded
- [ ] T12 — `bun run demo:up`, `bun run test:live`, `bun run demo:record`, `bun run demo:down`
- [ ] T13 — `bun run test:chaos` (in-process, embedded, Temporal Cloud)
- [ ] T14 — `bun run test` and `bun run test:node`; CI matrix green
- [ ] T15 — `bun run test:unit`
- [ ] All — `bun run check` green on the final commit

## Verification results

_Not yet executed._

| Activity | Command / procedure | Outcome | Evidence |
| -------- | ------------------- | ------- | -------- |
|          |                     |         |          |

**Not executed:** —

## Review comments

> Appended by the-loop's `record-feedback` hook when a human gate approves with
> comments (issue-109). Append-only and attributed: an approval never silently
> discards a reviewer's suggestions, and the feedback travels with the document
> it concerns rather than living in a side-channel tracker.

### 2026-11-14 — approved

**@MadaraUchiha-314** wrote:

approved
