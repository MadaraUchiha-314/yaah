# decision-011 — Hooks are MCP tools named by a client extension

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

A hook is an MCP tool an operator binds to a lifecycle event; there are no shell-command hooks.

## Alternative considered

Shell-command hooks, as in coding-harness plugins.

## Why

yaah has no shell by design: it runs customer-facing workflows, not code.

## Cost

Hooks written for other harnesses do not run here.
