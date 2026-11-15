# Crash recovery (T13)

Run on 2026-11-14 at commit `b3deea5` (branch `issue-3-8-extensibility`), Bun 1.4.0, Node 26.7.0, Linux x64.

`bun run test:chaos` — a harness in its own process is killed with `SIGKILL` while a
tool call is in flight, then started again on the same data.

```text
 6 pass
 0 fail
Ran 6 tests across 1 file. [144.27s]
```

Six runs: two scenarios in each of three modes — in-process journal (`none`), embedded
Temporal, and **Temporal Cloud** (namespace `yaah.gtebu`).

| Scenario | What is counted | Result in every mode |
| --- | --- | --- |
| A crashed run resumes without repeating a recorded step | the tool is **not** safe to retry | the task completes; the tool ran once; the model was called twice (once before the crash, once after) and was told the outcome is unknown |
| A tool that is safe to retry is run again after a crash | the tool is safe to retry | the task completes with the tool's result; the tool ran twice; the model call recorded before the crash was not repeated |

The kill point is "mid-tool". A kill in the middle of a model call is not a separate
scenario here; the in-process replay tests (`test/integration/replay.test.ts`,
`restart.test.ts`) cover a restart between and during steps without a real `SIGKILL`.
