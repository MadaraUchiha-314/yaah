# CLAUDE.md — working in yaah

**yaah** (Yet Another Agent Harness) is developed with
[the-loop](https://github.com/MadaraUchiha-314/the-loop), a product-development-lifecycle
harness. `.claude/settings.json` registers the-loop's marketplace and enables the
`the-loop@the-loop` plugin, so its skills, commands and SessionStart hook load in every
Claude Code session here.

## What to do

1. **Read the operating model first.** [`.the-loop/harness-config.yaml`](.the-loop/harness-config.yaml)
   (this project's config) and the plugin's `the-loop` skill are the source of truth for
   how work is done. Follow them — don't re-derive the process.
2. **Every change is a work item with a ticket.** Work is driven from a GitHub issue.
   Specs live under `docs/specs/<id>/`; scale rigor to the change per the skill's risk
   tiers.
3. **Keep the `loop:<phase>` label in sync** on the ticket at every transition.
4. **Keep the knowledge trees current:** `docs/architecture/`, `docs/capabilities/`,
   `docs/decisions/` and `docs/learnings/`, updated in the same PR as the change.
5. **People and roles** live in [`.the-loop/collaborators.yaml`](.the-loop/collaborators.yaml).

See also [`AGENTS.md`](AGENTS.md) for harness-agnostic instructions.
