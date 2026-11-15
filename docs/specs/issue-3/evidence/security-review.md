---
type: evidence
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Security review: yaah — Yet Another Agent Harness

> The `security-review` node's proof. See the-loop's `reference/security.md`.

## Security review (gate)

- **Mechanism:** Claude Code's built-in `security-review` skill, run on 2026-11-15 over
  the whole branch against `main` at `45fc46e`. One discovery pass reads the code for
  high-confidence, exploitable vulnerabilities; a false-positive filter then runs on
  each finding, and only findings scoring 8/10 or above are kept. The threat model given
  to it was the requirements' Security considerations (twelve abuse cases), with
  "no authentication" stated as a recorded product decision (decision-012), not a finding.
- **Outcome:** **pass** — no vulnerability met the bar, so the false-positive filter had
  nothing to filter. This follows two self-review rounds and a security-focused negative
  test suite that together fixed 50+ defects, including six of high severity
  (`evidence/self-review.md`, `evidence/security-tests.md`).
- **Findings:** none at or above the bar. Two noted below it, with dispositions:

  | Below the bar | Why not a finding | Disposition |
  | --- | --- | --- |
  | A caller can set `depth` and `parentTasks` in the `task-model` extension and so get past the delegation depth limit | Resource exhaustion; the per-caller open-task and rate limits, the iteration limit and the token budget still bound it | Accepted for this work item; noted for the authentication plugin, which will own caller-supplied task metadata |
  | `resolveInside` reports "missing" before "escape", so a model could probe whether a path outside a skill's root exists | Leaks existence only, never content; reachable only by the model through `read_skill_file` | Accepted |

- **Found after this review, by the critic round, and fixed:** two security-relevant
  defects the skill did not report. (1) Temporal activity failures carried an
  unredacted error message, stack and cause into Temporal's history and the worker's
  log, so a credential inside a provider error left the process — fixed in `8390f68`,
  with a scenario on embedded Temporal asserting the credential is in neither the
  history nor the worker's log. (2) A tool could still run after its task was cancelled
  while a tool hook was deciding — fixed in `25193a4`. Also fixed from the same round:
  the open-task limit under concurrent requests (`61496c7`) and the part-size limit in
  bytes (`7c83f56`). See `evidence/critic-review.md`.
- **What it examined:** the HTTP guards (Host, Origin, caller key, internal headers,
  content types); the web chat and A2UI rendering (no `dangerouslySetInnerHTML`, URL
  scheme allow-lists, the hardened catalog); the terminal output filter; path
  containment for skills and plugins; subprocesses (recorder, stdio MCP) and their
  environment; SQL (all parameterised); prompt templating (single pass); tool, skill and
  agent authorisation; secrets (redactor, embedded Temporal bound to loopback, the
  browser build's documented credential caveat).
- **Effective risk tier:** 4 — the change touches fixed sensitive paths
  (`.github/workflows/**`, `**/*schema*`, `**/*credential*`).
- **Human sign-off:** **approved** by @MadaraUchiha-314 (role: approver), 2026-11-15 —
  [comment](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6901073505),
  given after the critic round's security fixes were recorded here. The two residual
  risks above were put to them in the same request and accepted.
