---
type: evidence
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Explainer: yaah — Yet Another Agent Harness

> Written by the `code-explainer` node (issue-488): where the explainer of the change
> and the code quiz were published, so the `code-quiz` gate and the reviewer briefing
> can link them. The node blocks until this section names a `Location`. How to write
> the page itself: the skill's `reference/explainer.md`.

## Explainer

| Field | Value |
|---|---|
| Depth | deep |
| Location | https://claude.ai/artifact/HvdsPQYoim6RapFNnJtDnn |
| Published as | spec-chain artifact tab |
| Questions | 5 |

Tabs "Explainer" and "Code quiz" were added to the spec-chain artifact (version 8),
beside the spec tabs and the spec explainer. The page was written from the code at
`2313500` on `issue-3-8-extensibility` (pull requests #7–#13): background by layer, one
message followed end to end, a walkthrough in execution order with `file:line`
excerpts, and the risks and limits a maintainer must know. The quiz mixes code-level
questions (crash replay of an unsafe step, a cancel during a tool hook, credentials in
Temporal failures) with spec-level ones (why the loop is pure, how DNS rebinding is
stopped). It was checked in Chromium: all five questions render and grade, with no
script errors.
