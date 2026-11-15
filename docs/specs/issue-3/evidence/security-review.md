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

- **What it examined:** the HTTP guards (Host, Origin, caller key, internal headers,
  content types); the web chat and A2UI rendering (no `dangerouslySetInnerHTML`, URL
  scheme allow-lists, the hardened catalog); the terminal output filter; path
  containment for skills and plugins; subprocesses (recorder, stdio MCP) and their
  environment; SQL (all parameterised); prompt templating (single pass); tool, skill and
  agent authorisation; secrets (redactor, embedded Temporal bound to loopback, the
  browser build's documented credential caveat).
- **Effective risk tier:** 4 — the change touches fixed sensitive paths
  (`.github/workflows/**`, `**/*schema*`, `**/*credential*`).
- **Human sign-off:** **pending** — a tier-4 work item needs a named human to approve
  this security review before it completes. Requested on the pull request.
