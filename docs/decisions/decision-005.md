# decision-005 — Temporal history carries references, not content

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

Step inputs and outputs are ids, names, counts and flags. Conversation content, tool results and state live in yaah's own stores, written under the step's key.

## Alternative considered

Keep messages in workflow state.

## Why

Temporal limits a payload to 2 MB and a history to 50 MB, and customer text would otherwise sit in Temporal Cloud by default.

## Cost

A task needs both Temporal and yaah's store intact to resume. Tool names, tool arguments and token counts are still visible in history; `durable.temporal.encryptionKeyEnv` is the planned answer for those.
