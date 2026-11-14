# Capability: Tools, MCP and sub-agents

> What the agent can do besides talk: call tools, and hand work to other agents.

## What it is

A tool is a `tool` entity with a JSON Schema for its arguments. Tools come from code (`defineTool`), from MCP servers named in the configuration, and from yaah itself (the plan, state and `ask_user`). Another agent is an `agent` entity reached over A2A, including the harness itself (`self`).

## Current behaviour

- The system SHALL validate a tool call's arguments against the tool's schema before the tool runs, and SHALL return a refusal to the model as the tool result WHEN the tool is not registered, the arguments are invalid, the tool declares no schema, or a tool guard denies the call.
- The system SHALL run the tool calls of one model reply in parallel, bound each by a timeout, and report a thrown error to the model as a failed result, redacted.
- WHEN an MCP server is configured (`[[mcp.servers]]`, stdio or streamable HTTP) THEN the system SHALL register its tools as `mcp__<server>__<tool>`; IF the server is unreachable THEN start-up SHALL continue and the system SHALL retry with growing delays.
- The system SHALL present tool results, tool descriptions and agent replies to the model as data, and nothing in them SHALL add a tool, a permission or a configuration change.
- WHEN the model calls `invoke_agent` THEN the system SHALL delegate over A2A through the SDK client, track the sub-task in the task model, and accept later events only for sub-tasks it delegated, matched on task id and context id.
- IF delegation would exceed `limits.max_agent_depth` THEN the system SHALL refuse it.
- The system SHALL connect only to agent cards and MCP servers named in the operator's configuration, SHALL refuse a card whose interfaces point at a host that was not allowed (`a2a.allowed_hosts`), and SHALL never fetch a URL it was given at run time.

## Design

- [design.md — Tools and MCP; Sub-agents](../specs/issue-3/design.md#tools-and-mcp)
- [Security design](../specs/issue-3/design.md#security-design)

## History

| Work item | What changed | Links                                 |
| --------- | ------------ | ------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), PR #8, #10 |
