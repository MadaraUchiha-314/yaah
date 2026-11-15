# Capability: Durable execution

> A task survives a restart, in process or on Temporal.

## What it is

The core loop runs on a step runner chosen by `durable.mode`. Whatever the mode, the loop and the step implementations are the same code, proved by one contract suite.

## Current behaviour

- WHEN `durable.mode = "none"` THEN the system SHALL run each task in process and journal every completed step, and after a restart SHALL replay the journal so that no completed step is performed twice.
- WHEN `durable.mode = "temporal-embedded"` THEN the system SHALL start a Temporal dev server on loopback and run each task as a workflow (`yaah-<taskId>`) whose activities are the steps.
- WHEN `durable.mode = "temporal-remote"` THEN the system SHALL connect to `durable.temporal.address` with the key named by `api_key_env`, and IF the cluster is unreachable THEN SHALL refuse to start.
- WHEN a step fails with a retryable error THEN the system SHALL retry it under `durable.retry` (backoff, maximum attempts).
- IF a step that is not safe to repeat was in flight when the process died THEN the system SHALL NOT repeat it and SHALL record its outcome as unknown for the model.
- The system SHALL keep conversation content out of Temporal history: steps exchange ids, names, counts and flags.
- WHILE a Temporal mode is active the system SHALL print the Temporal Web UI address at start, publish it in the agent card (`durable-execution` extension), and link each task to its workflow; both chats show the link.
- After a restart the system SHALL give every open task its run back and deliver again what was accepted but not consumed.

## Design

- [Architecture — the loop and its steps](../architecture/architecture.md#the-loop-and-its-steps)
- [design.md — Durable execution](../specs/issue-3/design.md#durable-execution)
- Contract suite: `src/testing/durable-contract.ts`; crash tests: `test/chaos/`

## History

| Work item | What changed | Links                                                                                                                                                                       |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-002](../decisions/decision-002.md), [decision-005](../decisions/decision-005.md), [decision-008](../decisions/decision-008.md), PR #11 |
