# Capability: User interfaces: the terminal chat and the web chat

> Two chats that talk to a harness the way any A2A client does, and can share a task.

## What it is

Both chats are built on one session (`HarnessSession`, the A2A SDK client) and one view of a task (`TaskView`); each only draws that view. A third party can build another the same way and prove it with `rendererContract`.

## Current behaviour

- Both chats SHALL show the task's state in words (never by colour alone), the transcript as it streams, each tool call with its outcome, and a question from the agent as a distinct, labelled block.
- Both SHALL offer completing and cancelling the open task, and, WHEN the harness runs on Temporal, a link to the task's workflow.
- WHILE the typed text starts with `/` and names a command the harness lists THEN the chat SHALL mark it as a command; a command's reply is shown as a note and never reaches the model.
- WHEN the agent sends A2UI from the basic catalog THEN the web chat SHALL render it with the official renderer and the terminal chat SHALL draw it as text with focusable controls; a user's action is sent back to the agent.
- IF an A2UI surface names a component outside the catalog, or is malformed, THEN the chat SHALL show a textual fallback and render nothing else of it. The web chat allows only `https:` (and `data:image/` for images) in links and media, and never injects agent text as HTML.
- The terminal chat SHALL remove control and escape sequences from everything it prints, SHALL never draw taller than the terminal (the latest lines stay visible), and SHALL restore the terminal on exit. WHEN output is not a terminal or `NO_COLOR` is set THEN it SHALL print plain lines and read lines.
- WHEN opened with `yaah tui --url <harness> --attach`, or the web chat with `/?attach`, THEN the chat SHALL take up the task that is already open on the harness. A chat SHALL show what another surface does on its task while it is not in a turn of its own.
- The web chat SHALL honour a request for reduced motion (no transitions or animations), follow the system's light or dark theme, work down to 400 px wide, be operable by keyboard alone, and have no serious or critical axe violation (WCAG 2.1 A and AA).
- The web chat is served by the harness at `/` in the `server` composition; `yaah` opens the terminal chat against its own harness over HTTP.

## Design

- [design.md — Surfaces and renderers](../specs/issue-3/design.md#surfaces-and-renderers); prototypes: [`design/web-chat.html`](../specs/issue-3/design/web-chat.html), [`design/tui.html`](../specs/issue-3/design/tui.html)
- Pictures of every state: [`evidence/ui/`](../specs/issue-3/evidence/ui/)
- Known gaps: agent text is plain text (no markdown); the terminal chat has no scrollback of its own and no interrupt key.

## History

| Work item | What changed | Links                                                                                                                              |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-009](../decisions/decision-009.md), [decision-010](../decisions/decision-010.md), PR #12, #13 |
