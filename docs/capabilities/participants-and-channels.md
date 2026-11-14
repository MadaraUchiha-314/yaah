# Capability: Participants and channels

> The harness knows who is on a task and asks the right one the right way.

## What it is

A task has participants, each with a role. A channel is how the harness and a participant reach each other. The default channel maps a person to the task's own conversation and an agent to an A2A call.

## Current behaviour

- WHEN the context is built THEN the system SHALL include the task's participants and the meaning of each role, from the overridable `roles` prompt.
- The system SHALL offer the model `message_participant`, for a quick question whose reply comes back as the tool result, and `create_task_for_participant`, for work an agent participant must do, tracked as a sub-task. Creating a task for a person is refused, pointing at `message_participant`.
- WHEN `message_participant` addresses a person THEN the system SHALL suspend the turn exactly as `ask_user` does and use their reply as the result.
- The system SHALL change a channel's participants only through the harness's `ChannelManager`; nothing a caller sends changes membership.
- IF a message declares (through the `channels` extension) a sender who is not a participant of the task's channel THEN the system SHALL reject it before it reaches the inbox or a model. A message that declares no sender is taken as the task's user.
- The declared sender is trusted: there is no authentication yet.

## Design

- [design.md — Inbox, heartbeat, channels](../specs/issue-3/design.md#inbox-heartbeat-channels)
- Schema: [`specs/a2a-extensions/channels.v1.schema.json`](../../specs/a2a-extensions/channels.v1.schema.json)

## History

| Work item | What changed | Links                                                                           |
| --------- | ------------ | ------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-012](../decisions/decision-012.md), PR #13 |
