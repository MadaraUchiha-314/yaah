# decision-004 — A2A is served and consumed only through the official SDK

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

The server is `@a2a-js/sdk`'s `DefaultRequestHandler` behind the SDK's own Express handlers (JSON-RPC at `/a2a`, HTTP+JSON at `/a2a/rest`). Every client — the terminal UI, the web UI, the `self` sub-agent, remote agents — uses the SDK client. No A2A framing is written by hand.

## Alternative considered

Wrap the SDK's JSON-RPC handler in `Bun.serve`.

## Why

The SDK ships Express handlers for both bindings; a Bun adapter would re-implement SSE framing and version negotiation, which is the hand-rolling the issue forbids.

## Cost

An Express dependency, and the SDK's limits become ours (for example its handler-facing task store interface, which `handlerFacing` adapts).
