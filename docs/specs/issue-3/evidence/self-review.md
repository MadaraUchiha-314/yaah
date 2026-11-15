---
type: evidence
phase: needs-review
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Self-review: yaah — Yet Another Agent Harness

> The `self-review` node's proof. Policy (`the-loop critic policy`): 2 self rounds,
> 1 critic round, stop on no new findings, escalate on a repeated finding. Every finding
> is answered on the pull request before it is fixed, and fixed in a commit of its own
> with a test that fails without the fix.

## Review cycles

| Round | Reviewer | Outcome | Findings → disposition | Link |
| ----- | -------- | ------- | ---------------------- | ---- |
| 1 | `[claude/fable-5.2]` — three fresh-eyes reviewers, one per area: core and app layer; harness extensions; surfaces, CLI and build | 36 new findings (5 high, 16 medium, 15 low); 25 confirmed by reading or by running them, 11 plausible | all will-fix; see below | [core](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6889638160), [extensions](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6889635531), [surfaces](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6897301093) |

## Round 1 — what was fixed

_In progress._

## Found outside the rounds

| What | How it surfaced | Fix |
| --- | --- | --- |
| The agent card was computed once when the listener started, so an extension or command registered later (A2UI, `/model`) could be missing from it | CI: `tests on Node 24` failed on two tests on `d2945f6` | `1d23ccd` — the card is built when it is served; scenario "The agent card lists what plugins add after the listener started" |
