# decision-010 — The official A2UI renderer and basic catalog, themed

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

The web UI renders A2UI with `@a2ui/react` and the basic catalog, themed through its CSS variables. The agent side validates what the model wrote with `@a2ui/agent` before anything is sent. The terminal UI draws the same catalog as text.

## Alternative considered

Re-implement the catalog's components with shadcn primitives.

## Why

Binding and validation correctness come from the official renderer; theming gets the look.

## Cost

The catalog's components do not server-render, which does not matter for a client-side chat. A component outside the catalog is shown as its text fallback, never executed.
