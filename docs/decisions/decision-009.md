# decision-009 — Ink for the terminal UI

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

The terminal UI is Ink with React.

## Alternative considered

OpenTUI.

## Why

OpenTUI needs Bun, or Node 26.4+ with an experimental flag. Ink is pure JavaScript and runs wherever yaah does.

## Cost

Fewer built-in widgets. Audio capture, when it comes, is by spawning a system recorder.
