# Capability: Tasks and their lifecycle

> A conversation is a task that lives across turns until a client ends it.

## What it is

Every conversation with the harness is an A2A task. A client may ask for a **long-running** task, which stays open between turns; the agent may also suspend a task to ask the person a question. Clients are A2A clients: the two chats that ship with yaah, another agent, or an application.

## Current behaviour

- WHEN a message arrives without a task id THEN the system SHALL create a task and answer on it.
- WHEN a client asks for a long-running task (`task-lifecycle` extension, `longRunning: true`) THEN the system SHALL keep the task in `INPUT_REQUIRED` between turns, with the sub-state `awaiting-next-interaction` in the status message's metadata.
- WHEN the model calls `ask_user` THEN the system SHALL suspend the turn, put the task in `INPUT_REQUIRED` with sub-state `awaiting-user-input` and the question as the status message, and use the next message as the answer to that call.
- WHEN a client sends `{ action: "complete" }` on the `task-lifecycle` extension THEN the system SHALL move the task to `COMPLETED`; WHEN a client cancels THEN to `CANCELED`. A task that is not long-running completes after its answer.
- WHEN a message arrives for a task that is working THEN the system SHALL store it and show it to the model at its next iteration; with `interrupt: true` (`inbox-events` extension) it SHALL abort the iteration in progress first. Each such message gets a well-formed stream of its own.
- The system SHALL store every accepted message before delivering it, and SHALL consume each exactly once, also across a client retry and a restart.
- IF a task exceeds `limits.max_iterations` or `limits.max_task_tokens` THEN the system SHALL fail it.
- The system SHALL publish the task's plan, participants and sub-tasks through the `task-model` extension, and what the agent is doing right now through the `activity` extension.

## Design

- [Architecture — one request, the loop and its steps](../architecture/architecture.md)
- [design.md — Core loop; Task, plan, step, state; A2A extensions](../specs/issue-3/design.md#core-loop)
- Schemas: [`specs/a2a-extensions/`](../../specs/a2a-extensions/)

## History

| Work item | What changed | Links                                                                                                                                 |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-002](../decisions/decision-002.md), [decision-003](../decisions/decision-003.md), PR #8, #9, #13 |
