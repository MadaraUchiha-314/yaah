# Decision 002: the interpreter pin is Python 3.13, not 3.14

- **Status:** accepted
- **Date:** 2026-09-13
- **Deciders:** @MadaraUchiha-314 (approver) — proposed by the-loop, logged in
  [`conflicts.md`](conflicts.md)
- **Work item:** [issue #3](https://github.com/MadaraUchiha-314/yaah/issues/3)

## Context

Issue #3 says "Use the latest version of python 3". Read literally on the date this work
item ran, that is 3.14. But the `uv` available to the implementing environment resolves no
stable 3.14 — its embedded interpreter index stops at `3.14.0rc2` — and `uv self update`
could not reach GitHub to fetch a newer `uv`.

That turns a version choice into a conflict between two rules this repository holds:

- *use the latest Python 3* — the owner's instruction, and
- *CI/CD must use exactly the same tooling as local* — the-loop's rule, and the reason
  this work item exists at all.

Pinning 3.14 would satisfy the first and break the second: GitHub's runners install a
current `uv` that resolves 3.14 happily, so CI would run on an interpreter no local
environment in this project could install. Every check would then be unverifiable locally
— and an unverifiable gate is not a gate.

## Decision

`.python-version` pins **3.13** (a minor-series pin, so patch releases are picked up
automatically) and `requires-python` is `>=3.13`. CI names no version of its own: both
`ci.yml` and `release.yml` install `uv` without a `python-version` input, so
`.python-version` is the single interpreter pin everywhere. That invariant is asserted by
`tests/integration/test_workflows.py::test_ci_pins_the_interpreter_to_the_repository_pin`.

"Latest Python 3" is therefore implemented as **the latest stable release the pinned
toolchain can resolve**, not the latest release that exists.

## Consequences

**Easier.** Everything verifies locally, which is the property the rest of this work item
is built on. `uv sync` fetches the interpreter, so no contributor installs Python by hand.

**Harder.** yaah is one minor version behind for now, and nothing automatically notices
when that stops being necessary.

**The upgrade is one line.** Change `.python-version` to `3.14`, raise `requires-python`,
update the `Programming Language :: Python :: 3.13` classifier and `[tool.ruff]
target-version` / `[tool.pyright] pythonVersion`, and re-lock. The integration test above
keeps CI honest through the change.

## Alternatives considered

- **Pin 3.14 anyway** — breaks local/CI parity, as argued above.
- **Pin 3.14 in CI and 3.13 locally** — the same break, stated explicitly instead of
  accidentally.
- **Leave the interpreter unpinned** (`requires-python` only) — then every machine and
  every runner chooses its own, which is the drift this repository is built to prevent.
