---
type: evidence
phase: needs-review
workItem: "github:MadaraUchiha-314/yaah#3"
---

# Self-review: yaah — Yet Another Agent Harness

> The `self-review` node's proof. Policy (`the-loop critic policy`): 2 self rounds,
> 1 critic round, stop on no new findings, escalate on a repeated finding. Every finding
> is answered on the pull request before it is fixed, and fixed in a commit of its own
> with a test that fails without the fix.

## Review cycles

| Round | Reviewer | Outcome | Findings → disposition | Link |
| ----- | -------- | ------- | ---------------------- | ---- |
| 1 | `[claude/fable-5.2]` — three fresh-eyes reviewers, one per area: core and app layer; harness extensions; surfaces, CLI and build | 36 new findings (5 high, 16 medium, 15 low); 25 confirmed by reading or by running them, 11 plausible | all will-fix; see below | [core](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6889638160), [extensions](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6889635531), [surfaces](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6897301093) |

## Round 1 — what was fixed

| Batch | # | Finding (short) | Commit |
| --- | --- | --- | --- |
| core | 1 | A cancelled or failed task revived by a stranded inbox item | `9bf8e8b` |
| core | 2 | `tasks/cancel` cancelled nothing after a restart | `34b6f3d` |
| core | 3 | Origin check bypassed by DNS rebinding | `df8eb3d`, `822ad5b` |
| core | 4 | Credentials in a tool's data parts and artifacts not redacted | `8f512a7` |
| core | 5 | A resent, already consumed message hung the request | `a12ab71` |
| core | 6 | One interrupted tool call disabled compaction | `d5ed681` |
| core | 7 | Per-caller limits keyed on a client-chosen `X-Forwarded-For`; rate map never shrank | `008270d` |
| core | 8 | Stream hub kept every task's events forever | `11dd85c` |
| core | 9 | Internal settings (creator's IP address) returned to callers | `44deabe` |
| core | 10 | Under Temporal, an abandoned step could still write (verified on embedded Temporal) | `bade2b8` |
| core | 11 | A failure to take a message failed the live task | `a69bae6` |
| core | 12 | A sub-task event taken as the answer to `ask_user` | `80ca776` |
| extensions | 1 | `agent.before` not asked for agents reached through channel tools | `8b0d703` |
| extensions | 2 | A plugin's policy hook answerable by another server's tool | `98621ba` |
| extensions | 3 | Caller-supplied task fields verbatim in a system message | `6a1fec4`* |
| extensions | 4 | Fallback tool-call ids not unique across responses | `4f66723`* |
| extensions | 5 | A sub-agent answering with a whole task gave an empty result | `ee3adbf`* |
| extensions | 6 | A non-image file in a tool result failed a task on Claude | `141a488`* |
| extensions | 7 | An unclosed `<a2ui>` tag discarded the rest of the answer | `7d071a1`* |
| extensions | 8 | An unresolvable `$ref` made a tool call throw | `72b2c32`* |
| extensions | 9 | A hook answering nonsense allowed the call | `3a4622b`* |
| extensions | 10 | One long agent card hid the others | `72a8f0e`* |
| extensions | 11 | `invoke_agent` accepted any task id | `5db9665` |
| extensions | 12 | A declared channel bypassed the task's own membership | `ac7d5cc` |
| surfaces | 1 | A follower dropped a message repeating earlier text | `7904bbf` |
| surfaces | 2 | Bidi and zero-width characters passed both text filters (U+200C/D kept on purpose) | `b73cc7e` |
| surfaces | 3 | A follower update replaced the whole view | `e2027a4` |
| surfaces | 4 | Page fallback failed under a dot-directory or a relative directory | `6f12807` |
| surfaces | 5 | `yaah tui --url` crashed on an unreachable harness | `ce64b5c` |
| surfaces | 6 | Spoken answers kept playing after being turned off | `b0c0d84` |
| surfaces | 7 | Terminal form ignored replaced A2UI batches | `66f7023` |
| surfaces | 8 | `--config` took a flag as its value; `--url` took any scheme | `1ef5042` |
| surfaces | 9 | A cancelled partial answer stayed "streaming" | `631dd07` |
| surfaces | 10 | SIGTERM/SIGHUP left the harness running in chat mode | `94821b5` |
| surfaces | 11 | Browser build's Node-only check skipped a package-named plugin (dynamic imports still not walked) | `42ab106` |
| surfaces | 12 | The terminal recorder could outlive its recording | `f979736` |

\* commit ids as authored on the fixer's branch; on this branch they were cherry-picked, see `git log --grep "self-review 1"`.

Every fix has a test that failed before it and passes after. Merged result: `bun run check` 1148 pass; `bun run test:node` 1079 pass; `bun run test:e2e` 47 pass three runs in a row; `bun run test:chaos` 6 pass; `bun run test:live` 5 pass.

## Found outside the rounds

| What | How it surfaced | Fix |
| --- | --- | --- |
| Three intermittent tests: an axe contrast check caught a button mid-fade; the pty test pressed a key mid-turn; durable contract tests ran under a 5 s limit while waiting up to 20 s | fixers' runs under load | `9d764a8` — the web chat honours reduced motion everywhere (a real accessibility fix), the pty test waits for the resting state; `d07f682` — durable contract tests get 30 s |
| A race in the attach scenario: asserted before the adopted task's history arrived | the core fixer's runs | `6a73b01` |
| The agent card was computed once when the listener started, so an extension or command registered later (A2UI, `/model`) could be missing from it | CI: `tests on Node 24` failed on two tests on `d2945f6` | `1d23ccd` — the card is built when it is served; scenario "The agent card lists what plugins add after the listener started" |
