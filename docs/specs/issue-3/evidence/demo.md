# Demo evidence — the definition of done (R27, T12)

One harness, a real model, both chats on one task. Recorded by `bun run demo:record`
(`test/demo/refund.demo.ts`), which drives the web chat in Chromium and the terminal chat
on a pseudo-terminal against the harness of `bun run demo:up`. The model is real, so the
script reads the screen and reacts; nothing the agent says is scripted.

| Run | Model | Durable execution | Result |
| --- | --- | --- | --- |
| `cloud-*` | OpenAI `gpt-6.1-sol` | Temporal Cloud, namespace `yaah.gtebu` | passed, 2026-11-14 |
| `embedded-*` | OpenAI `gpt-6.1-sol` | embedded Temporal | passed, 2026-11-14 |

Keys came from the desktop keyring (`OPENAI_API_KEY`, `TEMPORAL_API_KEY`); none is in
any file here.

## What happened, step by step (the Temporal Cloud run)

| # | Step | Evidence |
| --- | --- | --- |
| 1 | The harness starts and says where the Temporal Web UI is. | [`cloud-startup.txt`](demo/cloud-startup.txt) |
| 2 | Web: "Order A-1041 arrived damaged. Can I get a refund?" The agent calls `lookup_order` and `refund_policy` (MCP) in one reply and shows an A2UI form. | [`cloud-01`](demo/cloud-01-web-first-turn.png) |
| 3 | Web: the form is filled in and submitted; the action goes back to the agent. | [`cloud-02`](demo/cloud-02-web-form-filled.png) |
| 4 | The refund is above the automatic limit, so the agent asks for the decision and the task waits in `input-required` ("Needs your input"). | [`cloud-03`](demo/cloud-03-web-asked-for-decision.png) |
| 5 | Terminal: `yaah tui --url … --attach` takes up the same task and shows the question. | [`cloud-04`](demo/cloud-04-tui-attached.png) |
| 6 | Terminal: "Approved. Refund the full amount." The agent continues. | [`cloud-05`](demo/cloud-05-tui-answered.png) |
| 7 | Web, which sent nothing, shows the answer and the continuation. | [`cloud-06`](demo/cloud-06-web-sees-terminal-answer.png) |
| 8 | Terminal: `/model`, then one more turn on the same task. | [`cloud-07`](demo/cloud-07-tui-command-and-turn.png) |
| 9 | Web: **Complete task**. Both chats show it completed. | [`cloud-08`](demo/cloud-08-web-completed.png), [`cloud-09`](demo/cloud-09-tui-completed.png) |
| 10 | The task's workflow on Temporal Cloud is `COMPLETED`; its history shows the inbox signals and one `performStep` activity per step. | [`cloud-transcript.md`](demo/cloud-transcript.md) |

The full text of both chats is in [`cloud-transcript.md`](demo/cloud-transcript.md). The
embedded run has the same ten pictures under `embedded-*`, the Temporal Web UI showing
the workflow ([`embedded-10`](demo/embedded-10-temporal-web-ui.png)), and the web flow as
a GIF ([`embedded-web.gif`](demo/embedded-web.gif)).

## Against the acceptance criteria

| Criterion | Met | By |
| --- | --- | --- |
| R27.1 one harness driven from the TUI and the web UI | yes | steps 2–9: one task id in both |
| R27.2 A2UI from the default catalog rendered in both, with an interaction round-tripped | yes | web: step 3 submits the form; terminal: steps 5–8 draw the same surfaces. A form submitted *from the terminal* is covered by `test/e2e/tui.spec.ts`, not by this run |
| R27.3 several turns on one long-running task until the user completes it | yes | steps 2–9 |
| R27.4 the agent asks, waits in `input-required`, continues on the reply | yes | steps 4–7 |
| R27.5 Temporal Cloud `yaah.gtebu` with OpenAI GPT 6.1 | yes | the `cloud-*` run |
| R27.6 the Temporal Web UI open at the URL shown, showing the task's workflow | partly | embedded: screenshot of the UI. Cloud: the link is shown in both chats and the workflow's history was read through the API; the Cloud web UI itself needs a signed-in browser, which this session does not have |
| R27.7 evidence committed, redacted | yes | this directory |

## What the run turned up

- **A transcript taller than the terminal broke the terminal chat** (first attempt at
  this demo). Fixed: the screen is now bounded by the terminal's height and shows the
  latest lines (`src/surface/renderer/tui/components.tsx`).
- **Neither chat could take up a task another had started.** Added: `--attach` and
  `/?attach`, and both chats now follow what the other does (`src/surface/attach.ts`).
- The model sometimes wraps a plain sentence in an A2UI text component; the terminal
  then draws it in the A2UI box. Valid, if a little heavy to look at.
