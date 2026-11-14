# decision-008 — Embedded Temporal comes from @temporalio/testing

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

Mode `temporal-embedded` starts Temporal's dev server through `@temporalio/testing`, with its Web UI on loopback. The dashboard URL is printed at start, published in the agent card, and each task links to its own workflow.

## Alternative considered

Spawn a `temporal` binary the user installs.

## Why

The package downloads and caches the right binary and exposes the options we need (UI, ports, a database file).

## Cost

The package is documented as a test tool: there is no public non-test API for the dev server. Durable modes are supported on Node LTS and best-effort on Bun.
