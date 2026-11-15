# decision-012 — No authentication on the A2A API in this work item

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#3](https://github.com/MadaraUchiha-314/yaah/issues/3) · [design](../specs/issue-3/design.md#trade-offs--decisions)

## Decision

The A2A API requires no authentication. The exposure is limited by a loopback default bind, an `Origin` check, per-caller limits on open tasks and request rate, and a warning printed whenever the listener is bound elsewhere.

## Alternative considered

Ship a bearer-token check now.

## Why

Decided by the product owner in review of the requirements ([comment](https://github.com/MadaraUchiha-314/yaah/pull/6#discussion_r4575328411)): an authentication plugin comes later.

## Cost

Anyone who can reach the port can read, continue, complete or cancel any task and spend the operator's model budget. Do not bind a non-loopback address on an untrusted network until the plugin exists.
