# Conflict & assumption log

Append-only log of ambiguities and conflicts hit **mid-flight** during a run (distinct
from the deliberate decisions in `decisions.md`). Rule: resolvable with a reasonable
default → **assume and continue**; genuinely blocked → **log, escalate once, move on**.

| Timestamp | Phase | Conflict / assumption | Status |
|-----------|-------|-----------------------|--------|
| 2026-09-13 | design | **"Latest version of python 3" resolved as 3.13, not 3.14.** Issue #3 asks for the latest Python 3; the `uv` available to the implementing environment resolves no stable 3.14 (its index stops at `3.14.0rc2`) and could not self-update. Pinning 3.14 would have made CI run on an interpreter no local environment could install, breaking the local/CI parity this very work item exists to establish. Default taken: pin the latest stable release the pinned toolchain resolves, and make the upgrade one line. Raised for confirmation on the ticket and recorded as [decision-002](decision-002.md). | assumed |
| 2026-09-13 | implementation | **`ruff format` reaches into markdown.** ruff 0.16 formats Python inside ```python fences, so `make format-check` (which runs over the whole tree) covered documentation while the pre-commit hook, scoped to `[python, pyi]`, did not — the two gates disagreed. Default taken: widen the hook to `markdown` rather than narrow the make target, so documentation snippets are held to the same style as the code. | resolved |
| 2026-09-13 | verification | **A repository-wide Vue delimiter override broke the site's own theme.** Added so GitHub Actions expressions in prose would not be evaluated, it also disabled interpolation inside VitePress's default-theme components — and the build reported success anyway. Default taken: revert the override, fence the one offending expression, and make `docs/scripts/build.mjs` fail the build when VitePress logs a rendering error and exits 0. Recorded in [decision-004](decision-004.md). | resolved |

_Status: `assumed` (default taken, continuing) · `escalated` (raised once, moved on) ·
`resolved` (later settled)._
