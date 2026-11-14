# decision-007 — zod is the one source for models, validation and published schemas

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

Configuration, A2A extension payloads and entity definitions are zod 4 schemas. Types are inferred from them, validation runs them, and the JSON Schemas under `specs/` are generated from them and held by a contract test.

## Alternative considered

TypeScript interfaces plus hand-written validators; or schemastery.

## Why

One definition cannot drift from itself. zod was already a transitive dependency.

## Cost

Schemas are values, so `isolatedDeclarations` needs an explicit type annotation on every exported schema.
