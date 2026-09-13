# Capabilities — yaah

The **organized view of the specs**: one living doc per capability, each the single source
of truth for that capability's *current* behaviour, with history rows tracing every
behaviour back to the raw specs (`docs/specs/<id>/`) and decisions that produced it.
Product-feature and architecture shaped capabilities are both valid; the taxonomy evolves
through PR-review feedback.

Affected capability docs are updated **in the same pull request** as the work item that
changes behaviour — that is a ready-to-ship gate item, not a follow-up.

| Capability | What it covers |
|------------|----------------|
| [Repository toolchain](repository-toolchain.md) | How yaah is linted, typed, tested, committed, versioned and published — one gate referenced by the git hooks, `make` and CI. |
| [Documentation site](documentation-site.md) | Every markdown document in the repository, published as a searchable site on GitHub Pages. |

New capability docs are scaffolded from the plugin's
`skills/the-loop/templates/capability.md`.
