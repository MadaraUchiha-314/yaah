---
type: evidence
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Documentation: yaah — Yet Another Agent Harness

> The `capability-docs` node's proof, and it gates **both** sections (issue-174). A work
> item that genuinely changed nothing in either says so **with the reason** — "internal
> refactor, no described behaviour changed" is an answer; a blank is not. A row names a
> **document**, never a token, a credential or an internal hostname: this tree is as
> public as the repository.

## Capability docs

> The ORGANIZED VIEW OF SPECS — current behaviour per capability, for a reader who
> already uses the project. Updated in the **same PR** as the change.

The repository had no capability docs before this work item; all thirteen are new, and
each was brought up to date with the behaviour the review fixes changed.

| Capability doc | What changed | History row |
|----------------|--------------|-------------|
| `docs/capabilities/capabilities.md` | The index: one row per capability below | — (index) |
| `docs/capabilities/tasks.md` | New: tasks, long-running tasks, sub-states, complete and cancel, interrupts, exactly-once delivery, limits | issue-3 — Introduced |
| `docs/capabilities/durable-execution.md` | New: modes `none`, `temporal-embedded`, `temporal-remote`; replay; unknown outcomes; references in history; the Temporal link | issue-3 — Introduced |
| `docs/capabilities/models.md` | New: OpenAI, Anthropic, OpenAI-compatible providers; `/model`, `/effort`; System One and inbox triage | issue-3 — Introduced |
| `docs/capabilities/tools.md` | New: tool validation and refusals, MCP, sub-agents, untrusted content as data; a cancelled task never runs a tool; `taskId` only for delegated tasks | issue-3 — Introduced |
| `docs/capabilities/extensibility.md` | New: Agent Skills, Agent Plugins 1.0.0, hooks that fail closed, prompt commands | issue-3 — Introduced |
| `docs/capabilities/participants-and-channels.md` | New: participants, roles, the two tools, membership, rejection of non-participants | issue-3 — Introduced |
| `docs/capabilities/observability.md` | New: JSON log records, OpenTelemetry spans, `traceparent`, OTLP and Langfuse, redaction at every exit incl. Temporal failures | issue-3 — Introduced |
| `docs/capabilities/configuration-and-cli.md` | New: `yaah`, `serve`, `tui --url --attach`, `config.toml`, compositions and overrides (an unknown override stops start-up), the SDK | issue-3 — Introduced |
| `docs/capabilities/api-security.md` | New: the A2A API's perimeter — Host/Origin (DNS rebinding), limits in bytes and per caller, `trust_proxy`, the heartbeat | issue-3 — Introduced |
| `docs/capabilities/user-interfaces.md` | New: the terminal and web chats, A2UI, output filtering, attaching to an open task, reduced motion, accessibility | issue-3 — Introduced |
| `docs/capabilities/modalities-and-voice.md` | New: images and audio in, images out, speech to text and text to speech, the microphone in both chats | issue-3 — Introduced |
| `docs/capabilities/browser-build.md` | New: the harness in a tab, the Node-only check, credentials in the page | issue-3 — Introduced |

## Documentation

> The USER-FACING surface — README, the docs site, the operating-model skill — for a
> reader who does not yet. It rots the same way, so it is updated in the same PR.

| Document | What changed |
|----------|--------------|
| `README.md` | Rewritten for users of the harness: what yaah is and is not, the no-authentication warning, running it (`yaah`, `serve`, `tui --url --attach`), configuring it (the example is checked against the schema), using it as a library, where the documentation lives, and every development script |
| `docs/architecture/architecture.md` | New: the source tree, one request end to end, the loop and its steps, durability modes, tasks over A2A, observability, security posture, how to extend yaah |
| `docs/decisions/decision-002.md` … `decision-012.md`, `decisions.md` | New: the eleven design decisions of the approved design (pure loop over a step runner, input-required with a sub-state, the official A2A SDK only, references in Temporal history, cordis 4 pinned, zod as the one schema source, embedded Temporal, Ink, the official A2UI renderer, hooks as MCP tools, no authentication) |
| `specs/` | New, generated and held by contract tests: the configuration schema, eight A2A extension schemas, the hooks schema, the package's export list, and the vendored Agent Plugins schemas |
| Docs site, operating-model skill | None in this repository |
