# Capability: The A2A API and its limits

> How clients reach the harness, and what stands between the network and a model call.

## What it is

The harness is an A2A 1.0 server built on the official SDK: an agent card, JSON-RPC at `/a2a` and HTTP+JSON at `/a2a/rest`. It has **no authentication** in this version; the measures below bound the exposure.

## Current behaviour

- The system SHALL serve the agent card at `/.well-known/agent-card.json`, listing its extensions, commands and the durable-execution mode.
- WHEN no host is configured THEN the system SHALL listen on loopback only; WHEN another address is configured THEN it SHALL say at start that the API is unauthenticated and where it listens.
- IF a request carries an `Origin` that is neither the harness's own nor in `server.allowed_origins` THEN the system SHALL reject it.
- IF a request's `Host` names neither the listener (its bound host and port; on loopback, `localhost`, `127.0.0.1` or `[::1]` with that port; on a wildcard bind, any IP address) nor a host in `server.allowed_origins` THEN the system SHALL reject it, so a page whose name was rebound to the harness's address cannot drive it.
- IF a request exceeds the limits on body size, part count or part size, or its caller has `limits.max_open_tasks_per_caller` open tasks or has had `limits.max_requests_per_minute` requests accepted in the last minute, THEN the system SHALL reject it before any model is called. A rejected request does not count against the caller's minute.
- WHEN `server.trust_proxy` is set THEN the system SHALL count a request against the last `X-Forwarded-For` entry — the address the proxy saw — never one the client wrote.
- WHEN a heartbeat fires (every `heartbeat.interval_ms`) THEN the system SHALL hand inbox items no run has taken back to their tasks, and SHALL emit `task/stalled` once for each working task with no progress for `heartbeat.stalled_after_ms`.
- IF a message has no text, file, data or lifecycle action THEN the system SHALL refuse it before a task is created.
- WHEN a message arrives for a task that is still working THEN its call SHALL get a well-formed stream of its own.
- The system SHALL redact registered credentials from every error returned to a caller.

## Design

- [Architecture — security posture](../architecture/architecture.md#security-posture)
- [requirements.md — Security considerations](../specs/issue-3/requirements.md#security-considerations), [design.md — Security design](../specs/issue-3/design.md#security-design)

## History

| Work item | What changed | Links                                                                                                                             |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-004](../decisions/decision-004.md), [decision-012](../decisions/decision-012.md), PR #9, #13 |
