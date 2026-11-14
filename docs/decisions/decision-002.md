# decision-002 — The core loop is a pure function over a step runner

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

`runTask(runner)` in `src/harness/core/loop.ts` performs no I/O and reads no clock. Everything with an effect is a named step (`conversation.accept`, `context.build`, `context.compact`, `llm.invoke`, `tool.invoke`, `task.transition`) performed by a `StepRunner`. Two runners exist: `DirectRunner` (in-process, journaled) and the Temporal workflow.

## Alternative considered

Build the loop on `@temporalio/vercel-ai-sdk`, which turns model and MCP calls into activities.

## Why

The issue requires a mode without Temporal and a browser build. An AI-SDK-shaped loop would tie the core to Temporal and to a second model abstraction. One loop means one set of scenarios proves both modes (`src/testing/durable-contract.ts`).

## Cost

We write and test the activity wiring, the journal and the replay rules ourselves. Step writes must be keyed and replace-on-retry, which every step implementation has to honour.
