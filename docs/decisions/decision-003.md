# decision-003 — A long-running task waits in INPUT_REQUIRED with a sub-state in metadata

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

Between turns a long-running task is in `TASK_STATE_INPUT_REQUIRED`. What it is actually waiting for (`awaiting-next-interaction`, `awaiting-user-input`) travels in the status message's metadata, defined by the `task-lifecycle` extension. A client ends the task with a message carrying `{ action: "complete" }`.

## Alternative considered

Stay in `WORKING` between turns; or one A2A task per turn inside a shared context.

## Why

A2A 1.0 forbids an extension from adding task states and forbids messages to a terminal task. `WORKING` tells every client the agent is busy and keeps non-streaming calls from returning. One task per turn is what A2A suggests, but the issue asks for one task across turns.

## Cost

A generic A2A client sees "input required" after every answer of a long-running task and must read the extension to tell the two cases apart.
