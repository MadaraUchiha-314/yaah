# decision-006 — cordis 4 release candidate, pinned exactly behind one kernel module

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

`cordis@4.0.0-rc.13` and its loader packages are pinned to exact versions. Only `src/kernel/bootstrap.ts` and `src/kernel/registry.ts` touch cordis APIs beyond `ctx.provide`, `ctx.on` and `ctx.effect`.

## Alternative considered

cordis 3 (`@cordisjs/core` 3.18).

## Why

3.x has been unmaintained since 2025-06 and its loader differs; the issue names the cordiverse repository, whose main branch is 4.

## Cost

A release-candidate API: an upgrade is a deliberate kernel-module edit. cordis keeps some service names for itself (`registry`, `runtime`, `logger`), so ours are `entities`, `taskRuntime` and `log`.
