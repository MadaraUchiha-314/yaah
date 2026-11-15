---
type: evidence
workItem: "issue-3"
---

# Design critic review: yaah — Yet Another Agent Harness

One round, run with `the-loop critic run codex` against `design.md` at commit `f836b20`,
with `requirements.md` as the reference. The operator's policy is one critic round
(`criticReviewCount: 1`). A first invocation ran in the wrong working directory and
reviewed nothing; it is not counted.

## Design critic review

| Round | Critic (`<harness>/<model>`) | Outcome | Findings → disposition | Link |
| ----- | ---------------------------- | ------- | ---------------------- | ---- |
| 1 | `codex/gpt-6.1-sol` | 14 findings (2 blocker, 12 major); all accepted and fixed in `design.md` | see below | [PR comment](https://github.com/MadaraUchiha-314/yaah/pull/6#issuecomment-6883355147) |

### Findings and dispositions

| # | Severity | Finding `[codex/gpt-6.1-sol]` | Affects | Disposition |
| --- | --- | --- | --- | --- |
| 1 | blocker | Exactly-once inbox consumption asserted with no atomic mechanism across independently replaceable stores. | R15.6, R17.3 | **Fixed.** Every write is keyed by a `StepKey` and replaces on retry; the crash table in _Persistence_ shows each interleaving. |
| 2 | blocker | `ask_user` had no suspension and resumption: the loop only waited between turns. | R14.3, R14.5, R27.4 | **Fixed.** `ask_user` is a suspending call handled by the loop: transition, wait on the inbox, store the reply as that call's result. |
| 3 | major | Executor delivered the item before subscribing to the hub; a fast run could finish unseen. | R15.4, R17.6, R20.2 | **Fixed.** Subscribe from a known sequence number before delivering; `StreamHub` replays; store-backed backstop. |
| 4 | major | Late inbox items were read at the next turn, not the next iteration. | R15.5 | **Fixed.** `drainInbox()` at every iteration; a turn cannot end with an unread item. |
| 5 | major | Cancel while idle in `nextInboxItem()` left the A2A task un-updated. | R3.5, R14.6 | **Fixed.** Every wait rejects with `TaskCancelledError`; an outer handler records `canceled` in a shielded step. |
| 6 | major | In-process hub with several replicas could lose deltas and even completion. | R17.6, R20.2, R21.1 | **Fixed by scoping.** One harness process per data store is the supported topology; status and artifacts are written to the task store before publishing; multi-replica is a named plugin seam. |
| 7 | major | Two-surface following was one `resubscribeTask` call with no recovery across turns. | R19.3, R14.2–14.3, R27.1–27.3 | **Fixed.** `HarnessSession.follow` is a snapshot-then-subscribe loop; a two-client, three-turn test is named. |
| 8 | major | The browser composition dropped the inbox, handler and runner with no replacement. | R25.1–25.2, R11.4 | **Fixed.** `shared/app.yml` (no listener) is split from `shared/http.yml`; `HarnessTarget` has an in-memory SDK transport. |
| 9 | major | Task limit was per context, which a caller bypasses with a fresh context id. | abuse case 8 | **Fixed.** Caller key (user, else remote address) with open-task and rate limits. |
| 10 | major | No token budget was enforced. | abuse case 9 | **Fixed.** `limits.max_task_tokens`, accumulated from provider usage and checked before each model call. |
| 11 | major | Redaction matched whole strings only and did not cover content entering prompts. | R18.4, abuse case 12 | **Fixed.** `Redactor` replaces substrings at four exits, including tool and sub-agent results before they are stored. |
| 12 | major | Untrusted tool and agent descriptions sit in section 3 while the security design said they never do. | abuse case 4 | **Fixed.** Descriptions only in tool-definition fields, sanitized and capped; the security text now says exactly that. |
| 13 | major | No receive-side channel membership check. | R12.5 | **Fixed.** `ChannelManager.receive` rejects a non-participant. |
| 14 | major | Missing contracts: prompt, skill, channel, compaction strategy, `StreamHub`, in-memory transport, `HarnessSession`. | R2.1, R26.7 | **Fixed.** All seven are specified. |
