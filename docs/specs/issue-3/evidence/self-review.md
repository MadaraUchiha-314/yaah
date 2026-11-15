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
| 2 | `[claude/opus-5.5]` — one reviewer: (A) each round-1 fix against its own scenario and for regressions; (B) the files round 1 did not read | 12 new findings (1 high, 9 medium, 2 low), all confirmed, plus 6 lower ones listed outside the twelve; **escalated**: round-1 core #8 and extensions #7 not fully closed, core #4 partial | all 18 will-fix | [round 2](https://github.com/MadaraUchiha-314/yaah/pull/13#issuecomment-6898458275) |

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

## Round 2 — what was fixed

| # | Finding (short) | Commit |
| --- | --- | --- |
| 1 | A non-blocking send then a resubscribe got no updates (regression from round 1's disconnect fix) | `2c2cc45` |
| 2 | File parts not redacted (**repeat**: round-1 core #4 partial) | `10632d0` |
| 3 | Continuing a sub-task returned all its earlier answers | `665dd57` |
| 4 | Parallel `invoke_agent` calls lost each other's records | `1ee79f0` |
| 5 | A task resting in `input-required` kept its stream log forever (**repeat**: round-1 core #8) | `1605e07` |
| 6 | The rate limiter's cost grew with the square of a flood | `f78eb05` |
| 7 | On a wildcard bind `localhost:<port>` was refused; Host case and default port | `fa7c461` |
| 8 | Speech and image plugins ignored the browser build's credentials | `2dc61e7` |
| 9 | Text-to-speech hung when its instructions could not be rendered | `376fc89` |
| 10 | `createHarness` left plugins running when `setup` or a ready handler threw | `7d0d60b` |
| 11 | A reply mentioning `<a2ui>` twice lost text (**repeat**: round-1 extensions #7) | `7569029` |
| 12 | A plugin's own clashing server ids left it half-registered | `9309afc` |
| 13 | Each binding had its own rate map | `ede11b8` |
| 14 | Behind two proxies every caller shared one key | `0066c52` — `server.trust_proxy` now takes `true`, a hop count or addresses |
| 15 | `image/jpg`, `image/PNG` replaced by the omitted-media note on Claude | `285975e` |
| 16 | An unknown `[[overrides]]` id was ignored | `6137583`; browser build `ffcba52` |
| 17 | Signal listeners outlived the terminal chat | `abcf037` |
| 18 | A refused Realtime handshake reported as retryable | **won't-fix in this work item**: Bun, Node and the browser `WebSocket` all hide the HTTP status of a refused upgrade, so 401 and 503 look the same to the provider. Follow-up: a socket factory that reports the upgrade response, or one HTTP probe when the socket never opened. The key is already kept out of the message |

Found by a round-2 fixer, same race as #4: participant changes on a channel could lose one another — `21da374`.

Merged result on round-2 fixes: `bun run check` 1177 pass · `bun run test:node` 1108 pass · `bun run test:e2e` 47 pass, twice · `bun run test:chaos` 6 pass (incl. Temporal Cloud) · `bun run test:live` 5 pass · `bun run build:browser` ok.

Self rounds stop here: the policy allows two. The critic round follows.

## Found outside the rounds

| What | How it surfaced | Fix |
| --- | --- | --- |
| Three intermittent tests: an axe contrast check caught a button mid-fade; the pty test pressed a key mid-turn; durable contract tests ran under a 5 s limit while waiting up to 20 s | fixers' runs under load | `9d764a8` — the web chat honours reduced motion everywhere (a real accessibility fix), the pty test waits for the resting state; `d07f682` — durable contract tests get 30 s |
| A race in the attach scenario: asserted before the adopted task's history arrived | the core fixer's runs | `6a73b01` |
| The agent card was computed once when the listener started, so an extension or command registered later (A2UI, `/model`) could be missing from it | CI: `tests on Node 24` failed on two tests on `d2945f6` | `1d23ccd` — the card is built when it is served; scenario "The agent card lists what plugins add after the listener started" |
