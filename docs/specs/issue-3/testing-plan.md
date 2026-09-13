---
type: testing-plan
phase: test-planning
workItem: "github:MadaraUchiha-314/yaah#3"
status: draft
approvedBy: []
overrides: {}
riskTier: 4
---

# Testing plan: repo tooling setup

> Derived from the approved `requirements.md` and `design.md`, **before** `tasks.md` —
> each task's `_Test:_` names a row of the matrix below. Authored at the `test-planning`
> node and **completed at the `verification` node**.
>
> **This file is executable content.** It names commands an agent will run, so review it
> like code. Credentials appear **by reference only** — and this work item has none.

## Test matrix

Most of what this work item delivers is *configuration*, so the matrix leans on two
row types: rows that **execute** the configuration (T2, T4, T6, T7) and rows that
**assert on its shape** where executing it would mean cutting a release or publishing a
site (T8).

| # | Type | Applies? | Scope / what it proves | Where it runs |
|---|------|----------|------------------------|---------------|
| T1 | Unit | yes | `hello_world` — default, named, and the rejection of non-`str`/blank input (R3) | `uv run pytest tests/unit` |
| T2 | Integration (scenario) | yes | the repository's own gate: `pre-commit` runs every configured hook over every file; the package imports as `from yaah import …`; the built wheel contains the package (R1, R2, R5) | `uv run pytest tests/integration` |
| T3 | Contract (OpenAPI / GraphQL SDL) | n/a — yaah exposes no HTTP or GraphQL API; `specs/openapi/` and `specs/graphql/` are deliberately absent | | |
| T4 | End-to-end | yes | the published artifact path end-to-end short of upload: `uv build` produces an `sdist` + `wheel` named `yaah`, and the wheel installs and imports in a clean environment (R7) | `uv build` + clean-venv install |
| T5 | UI / visual | yes | the documentation site renders — home page and a generated spec page — captured as screenshots (R8) | `bun run docs:build` + headless screenshot |
| T6 | Snapshot | n/a — no rendered output or serialized structure is asserted against a stored baseline; the site is proved by building and rendering it (T5), not by diffing HTML | | |
| T7 | Performance / load | n/a — no runtime component; the only latency that matters is the git-hook round trip, covered qualitatively by keeping integration tests out of the hooks (design § `.pre-commit-config.yaml`) | | |
| T8 | Security / abuse case | yes | one negative test per trust boundary in `design.md` § Security design: A1–A6 over the checked-in workflow YAML, A7 over `hello_world` | `uv run pytest tests/integration/test_workflows.py` |
| T9 | Accessibility | n/a — the site uses the unmodified VitePress default theme; no bespoke markup is introduced to audit | | |
| T10 | Migration / upgrade | n/a — greenfield. There is no prior tooling, no prior release and no consumer to migrate | | |
| T11 | Manual exploratory | yes | `uv sync` → `make check` from a clean clone, and `pre-commit install` followed by a deliberately malformed commit message, to confirm the contributor-facing path described in the docs (R1, R4, R5) | shell, recorded |

## Scenarios & requirement trace

| Row | Requirement(s) | Scenario / case |
|-----|----------------|-----------------|
| T1 | R3.1–R3.4 | `hello_world()` → `Hello, World!`; `hello_world("yaah")` → `Hello, yaah!`; `TypeError` on non-`str`; `ValueError` on empty/whitespace |
| T2 | R1.3, R1.5, R2.1–R2.4, R5.2 | `Scenario: The repository's own quality gate passes over every file` |
| T2 | R1.1, R1.2 | `Scenario: The pinned toolchain resolves from the committed lock` |
| T2 | R1.5 | `Scenario: The package is importable under its documented name` |
| T2 | R8.1, R8.2, R8.6 | `Scenario: The documentation site builds from docs/ with a generated specs sidebar` |
| T4 | R1.3, R7.5 | `Scenario: The distribution builds as yaah and installs from the wheel` |
| T5 | R8.2, R8.3 | Home page and a generated spec page render in a browser |
| T8 | A1 / R6, R7.6 | `Scenario: CI holds no publish credential` |
| T8 | A2 / R6.1 | `Scenario: No workflow runs untrusted branch code with a write-scoped token` |
| T8 | A3 / R7.6 | `Scenario: Release privileges are scoped per job` |
| T8 | A4 | `Scenario: No workflow interpolates untrusted input into a shell` |
| T8 | A5 | `Scenario: Every third-party action reference is pinned` |
| T8 | A6 / R7.4 | `Scenario: The release does not re-enter on its own bump commit` |
| T8 | A7 / R3.4 | covered by T1's negative cases |
| T11 | R1.1, R4.1, R5.1 | clean-clone bootstrap; malformed commit message rejected by the `commit-msg` hook |

## Verification environment

- **Repositories:** this repository only.
- **Services / containers:** none. Every check runs in-process.
- **Toolchain required:** `uv` (installs its own Python from `.python-version`), Node 22+
  with `npx` (markdownlint) and `bun` (the docs site). No other global install.
- **Fixtures & data:** none. The tests read the repository's own checked-in files.
- **Credentials:** **none.** This work item introduces no secret, and no verification
  activity authenticates to any service. The PyPI and Pages publish steps are *not*
  executed during verification — T4 stops at a built and locally installed artifact.
- **Bring-up:** `uv sync` · **Tear-down:** none (the `.venv` and `node_modules` are
  gitignored build state).
- **If bring-up fails:** record it under Verification results, leave the dependent
  activities unticked, and escalate — do not pass the gate on an environment that never
  came up.

## Evidence plan

| Row | Evidence | Path under `evidence/` |
|-----|----------|------------------------|
| T1 | pytest summary for the unit suite | `unit.md` |
| T2 | pytest summary for the integration suite | `integration.md` |
| T8 | the abuse-case suite, with each case mapped to the test that would catch its regression | `security.md` |
| T2 | full `pre-commit run --all-files` output | `pre-commit.md` |
| T4 | `uv build` output and the clean-venv install + import transcript | `build-and-install.md` |
| T5 | `vitepress build` output; screenshots of the rendered home page and a spec page | `docs-site.md`, `ui/home.png`, `ui/spec-page.png` |
| T11 | transcript of the clean bootstrap and the rejected commit message | `manual.md` |

Redaction: the captured output contains no token, cookie, personal data or internal
hostname — the commands run entirely against this repository's own files. Absolute paths
from the verification container are rewritten to repository-relative paths before
committing.

## Verification activities

- [x] T1 — `uv run pytest tests/unit -v`
- [x] T2 — `uv run pytest tests/integration -v`
- [x] T2 — `uv run pre-commit run --all-files --show-diff-on-failure`
- [x] T4 — `uv build` then install the wheel into a clean venv and `import yaah`
- [x] T5 — `cd docs && bun run docs:build`, then screenshot the built site
- [x] T8 — `uv run pytest tests/integration/test_workflows.py -v`
- [x] T11 — `uv sync && make check` from a clean state; `git commit -m "bad message"` rejected

## Verification results

Executed 2026-09-13 on branch `claude/github-issue-3-3lm0oe`. **Every planned activity
ran and passed.** Nothing was left unticked.

| Activity | Command / procedure | Outcome | Evidence |
|----------|--------------------|---------|----------|
| T1 — unit | `uv run pytest tests/unit -v` | pass — 9 passed | [`evidence/unit.md`](evidence/unit.md) |
| T2 — integration | `uv run pytest tests/integration -v` | pass — 15 passed | [`evidence/integration.md`](evidence/integration.md) |
| T2 — the gate | `uv run pre-commit run --all-files --show-diff-on-failure` | pass — every hook | [`evidence/pre-commit.md`](evidence/pre-commit.md) |
| T4 — e2e build | `uv build`, then install the wheel into a clean 3.13 venv and import it from outside the source tree | pass — `yaah-0.1.0` sdist + wheel; `Hello, clean venv!`; `py.typed` shipped | [`evidence/build-and-install.md`](evidence/build-and-install.md) |
| T5 — site build | `cd docs && bun run docs:build` | pass — build clean | [`evidence/docs-site.md`](evidence/docs-site.md) |
| T5 — site render | headless Chromium screenshots of four pages served from the built output | pass — after fixing a defect this activity caught (see below) | [`evidence/ui/`](evidence/ui/) |
| T8 — abuse cases | `uv run pytest tests/integration/test_workflows.py -v` | pass — 8 passed | [`evidence/security.md`](evidence/security.md) |
| T11 — manual | `uv sync` → `make hooks` → `make check` from a deleted `.venv/` | pass — green from a clean state | [`evidence/manual.md`](evidence/manual.md) |
| T11 — manual | `git commit -m "wire up the repo tooling"` | pass — rejected by the `commit-msg` hook, with commitizen's expected pattern printed | [`evidence/manual.md`](evidence/manual.md) |

**Not executed:** none. Two things this plan deliberately never executes, stated so the
absence is not mistaken for an omission: the PyPI **upload** and the GitHub Pages
**deployment**. Both are one-way and require the `main` branch; T4 and T5 prove the
artifact and the site right up to the point of publishing, and T8 proves the workflows'
shape.

### What verification caught

T5's render step is the reason this plan asks for screenshots rather than an exit code.
`vitepress build` reported success on a home page whose theme chrome rendered as literal
`{ { site.title } }` text — a repository-wide Vue delimiter override, added to stop
GitHub Actions expressions in prose from being evaluated, had also disabled interpolation
inside the default theme's own components. Two fixes landed: the override was removed in
favour of fencing the one offending expression, and `docs/scripts/build.mjs` now fails the
build when VitePress logs a rendering error and exits 0 anyway — so CI's `docs` job gates
what it was written to gate.

## Review comments

_None yet._
