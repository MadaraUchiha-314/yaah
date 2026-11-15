---
type: evidence
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Critic review: yaah — Yet Another Agent Harness

> The `critic-review` node's proof — a different model and harness reading the code
> after the two self-review rounds converged (`evidence/self-review.md`). Policy: one
> critic round. A round that could not run is recorded as `unavailable` and does not
> count.

## Review cycles

| Round | Critic (`<harness>/<model>`) | Outcome | Findings → disposition | Link |
| ----- | ---------------------------- | ------- | ---------------------- | ---- |
| — | `codex/gpt-6.1-sol` | **unavailable** — timed out with no report. Asked to review the whole diff from `main` (about 69,000 lines in 658 files), which does not fit one run. Does not count toward the round. | — | — |
| — | `codex/gpt-6.1-sol` | **unavailable** — twice more, each cut off at 120 s: routed through the-loop's background service, `the-loop critic run` waits at most 120 s for the HTTP reply whatever the round's limit. Run in-process (`THE_LOOP_SERVICE_LOCAL=1`) it completed. A defect of the-loop's CLI, not of the critic. | — | — |
| 1 | `codex/gpt-6.1-sol`, scoped to 22 files: crash recovery and exactly-once, the network boundary, tools/hooks/skills/plugins, path containment, redaction, output filters | 6 new findings (2 high, 3 medium, 1 low), each confirmed by the critic's own probe | all will-fix, all fixed | [round 1](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6899144711) |

## Round 1 — what was fixed

| # | Finding | Commit |
| --- | --- | --- |
| 1 | A tool could start after its task was cancelled during an async tool guard | `25193a4` |
| 2 | Temporal activity failures carried an unredacted message, stack and cause into Temporal's history and the worker's log | `8390f68` |
| 3 | Concurrent new-task requests passed the per-caller open-task limit | `61496c7` |
| 4 | The part-size limit counted UTF-16 units, not bytes; text parts unchecked in the in-memory path | `7c83f56` |
| 5 | Every completed step left an abort listener on the task's signal | `78ee27c` |
| 6 | A disposed plugin's commands stayed callable | `eb594db` |

Each fix has a test that failed before it. Merged result: `bun run check` 1195 pass ·
`bun run test:node` 1126 pass · `bun run test:e2e` 47 pass · `bun run test:chaos` 6 pass
(incl. Temporal Cloud) · `bun run test:live` 5 pass.

The critic did not read the rest of the diff (UIs, models, CLI, browser build): those
were covered by the two self-review rounds.
