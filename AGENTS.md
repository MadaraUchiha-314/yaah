# AGENTS.md — working in yaah

**yaah** (Yet Another Agent Harness) runs its own product development through
[**the-loop**](https://github.com/MadaraUchiha-314/the-loop), an opinionated
product-development-lifecycle harness installed here as a plugin. This file is the
harness-agnostic entry point: whichever agent you are, read it first.

`CLAUDE.md` is a pointer to this file plus the Claude Code specifics.

## Read these before acting

The-loop is the source of truth for *how* work is done here. Do not re-derive the process
from this file — read it from the plugin:

| Where | What it holds |
|-------|---------------|
| `skills/the-loop/SKILL.md` (in the plugin) | The operating model: artifact chain, phases, reviews, risk tiers. |
| `skills/the-loop/reference/workflow.md` | Phase-by-phase detail, TDD, the task DAG, resumability. |
| `skills/the-loop/reference/tooling.md` | Tooling detection, git hooks, CI parity. |
| [`.the-loop/harness-config.yaml`](.the-loop/harness-config.yaml) | This repo's harness config (the agent's file; the CLI never reads it). |
| [`.the-loop/collaborators.yaml`](.the-loop/collaborators.yaml) | Who collaborates here and in which roles — the only source for reviewers and approvers. |
| [`.the-loop/manifest.yaml`](.the-loop/manifest.yaml) | Every path the-loop creates or maintains in this repo. |

Templates and config schemas are **internal to the plugin** and are deliberately not
copied into this repository — read them from `${CLAUDE_PLUGIN_ROOT}`.

## The rules that apply to every change

1. **Every change is a work item with a ticket.** Nothing is worked without a GitHub
   issue. Create and lock the spec chain under `docs/specs/<id>/` before writing code —
   `requirements.md` (or `bugfix.md`) → `design.md` + `testing-plan.md` → `tasks.md` —
   **scaling rigor to the change** per the skill's risk tiers. A trivial (tier 1–2)
   change is autonomous-complete and needs no full chain; tier 3+ does.
2. **Keep the phase label in sync.** Apply and advance `loop:<phase>` on the ticket at
   every transition (`loop:not-started → … → loop:complete`), mirrored in
   `docs/specs/<id>/execution-log.md`.
3. **Self-review, then critic-review, before escalating to a human.** Humans are for
   decisions and opinions, not for catching what a review round would have caught.
4. **Every decision needs a paper trail.** Decisions land in
   [`docs/decisions/`](docs/decisions/decisions.md); mid-flight ambiguities you resolved
   with a reasonable default land in
   [`docs/decisions/conflicts.md`](docs/decisions/conflicts.md). All collaboration happens
   through ticket and pull-request comments.
5. **Update the affected capability docs in the same pull request** as the change that
   alters behaviour ([`docs/capabilities/`](docs/capabilities/capabilities.md)) — a
   ready-to-ship gate item, never a follow-up.
6. **Capture learnings.** Feedback that would change how the next work item runs goes to
   [`docs/learnings/`](docs/learnings/learnings.md).

## Where things live

```text
.claude/settings.json     # permissions + the-loop marketplace/plugin installation
.the-loop/                # this repo's harness config (no schemas, no templates)
docs/architecture/        # architecture index, per-component docs
docs/capabilities/        # organized view of the specs — current behaviour
docs/decisions/           # decision records + the conflict/assumption log
docs/learnings/           # learnings index + records
docs/specs/<id>/          # one directory per work item: the spec chain + execution log
```

## Commands

The-loop ships the commands that drive all of the above — `/the-loop:work-on <ticket>`,
`/the-loop:new-requirement`, `/the-loop:create-ticket`, `/the-loop:do-task`,
`/the-loop:verify-work`, `/the-loop:review-pr`, `/the-loop:work-status`,
`/the-loop:init`, `/the-loop:upgrade-the-loop`. Prefer them over improvising the same
steps by hand: they read the plugin's templates and keep the artifacts consistent.

## Tooling

yaah has no source tree yet, so there is no lint/typecheck/test toolchain to run. The
loop **detects** tooling off the repository at the start of every work item rather than
reading it from config, so the first work item that introduces code is also the one that
introduces its tooling — and must wire local git hooks and CI to the **same** root
commands (`reference/tooling.md` → "CI/CD must use exactly the same tooling as local").

**Prime directive: run the loop.**
