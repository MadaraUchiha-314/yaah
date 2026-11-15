# Capability: Observability

> What the harness did, as logs and traces, without leaking a credential.

## What it is

One plugin listens to requests, the inbox, every step and every command, and records them. It changes nothing: a composition without it behaves the same.

## Current behaviour

- The system SHALL write one JSON object per line — to standard error, or appended to `o11y.log_file` — for each accepted message, each step (`state.written`, `context.built`, `context.compacted`, `llm.invoked`, `tool.invoked`, `agent.invoked`, `task.transition`), each command, each stalled task and each heartbeat, at or above `o11y.log_level`.
- Every step record SHALL carry `taskId`, `contextId`, `traceId`, `stepName`, the duration and the outcome; a failed step is logged at level `error`.
- The system SHALL open one OpenTelemetry span per request and per step, named by the GenAI conventions (`chat <model>`, `execute_tool <name>`, `invoke_agent <id>`), the steps of a task being children of the request that reached it.
- WHEN a request carries a W3C `traceparent` THEN its span SHALL continue that trace; calls to other agents and to MCP servers SHALL carry the `traceparent` on.
- WHEN `o11y.otlp_endpoint` is set THEN spans SHALL be exported to `<endpoint>/v1/traces`; WHEN `o11y.langfuse` is set instead THEN to that Langfuse host with its Basic credentials.
- The system SHALL NOT put message content on spans or in log records.
- Every log record and span attribute SHALL pass through the redactor, as do errors returned to callers, content written to a conversation (text, data and file parts), artifacts, and a failing step's error — message, stack and causes — before it is recorded by Temporal.
- WHEN `yaah` runs with the terminal chat THEN the log SHALL go to a file (`~/.yaah/logs/yaah.log` unless configured), since the terminal belongs to the chat.

## Design

- [Architecture — observability](../architecture/architecture.md#observability)
- [design.md — Observability](../specs/issue-3/design.md#observability)

## History

| Work item | What changed | Links                                  |
| --------- | ------------ | -------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), PR #12, #13 |
