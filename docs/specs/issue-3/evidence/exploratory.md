# Exploratory session (T11)

2026-11-14, about forty minutes, by the agent that built the work item — not by a second
person, which the plan's "by hand" implied. Method: two `HarnessSession`s (standing in
for the web chat and the terminal chat) against one harness, trying to break turn-taking;
plus what running the live demo turned up. Each real defect got a scenario before the
fix.

| # | Tried | What happened | Outcome |
| --- | --- | --- | --- |
| 1 | Two surfaces sending on one task at the same moment, while a tool was running | Both messages were accepted and read by the model at its next iteration; all three streams ended cleanly. Before this session the second stream broke with an SDK "stream ordering violation" | **Fixed** earlier in this work item (`request-buses.ts`); scenario "A message for a working task gets a well-formed stream of its own" |
| 2 | The same, looking at each surface's own transcript | Each surface orders the concurrent messages slightly differently until it next reads the task | Accepted: cosmetic, and the task's own history is consistent |
| 3 | Cancel while idle, then send on the canceled task from a surface holding a stale view | The harness refuses ("terminal state… cannot be modified"); the chats start a new task instead once they have seen the cancel | Accepted. The SDK also prints a stack trace to stderr for every such refusal — noisy, left as is |
| 4 | An empty message, and one of only white space | Accepted, started a turn and cost a model call | **Fixed**: refused at admission; scenario "A message that says nothing is refused before any model call" |
| 5 | Malformed commands: `/`, `/ model`, `//model`, `/MODEL`, `/model nope/none`, `/effort   high  `, `/exit now` | `/`, `/ model`, `//model` are not commands and go to the model as text. `/MODEL` is "unknown command" with the list. A bad argument is refused with what is available. Extra spaces are tolerated. `/exit` at the harness says it belongs to the interface | As designed |
| 6 | Any command, then looking at the session's last view | The state stayed at "working" although nothing was running; both chats papered over it | **Fixed** in the session; scenario "After a command's reply the view is in the state it was in before" |
| 7 | A 300 000-character message | Accepted (under the body limit) and answered | As designed; the token budget bounds the cost |
| 8 | A NUL character inside a message | Passed to the model as text; the terminal filter strips it on display | Accepted |
| 9 | Live demo: a transcript taller than the terminal | The terminal chat's screen broke | **Fixed**: the screen is bounded by the terminal's height; unit test and the demo itself |
| 10 | Live demo: continuing in the terminal a task started on the web | Not possible: neither chat could take up an open task | **Fixed**: `--attach`, `/?attach`, and both chats follow each other; scenario "A second surface takes up an open task and both stay in step" |

Not tried: interrupting mid-tool from a chat (neither chat offers an interrupt key — the
harness side is covered by "An interrupting item aborts the current iteration"); a real
person using both chats.
