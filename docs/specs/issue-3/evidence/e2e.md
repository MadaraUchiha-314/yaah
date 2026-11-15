# End-to-end, visual and accessibility (T4, T5, T9)

Run on 2026-11-14 at commit `b3deea5` (branch `issue-3-8-extensibility`), Bun 1.4.0, Node 26.7.0, Linux x64.

`bun run test:e2e` (Playwright, Chromium). The web chat is driven in a real browser
against a harness with a scripted model; the terminal chat runs on a real pseudo-terminal
and its screen is read through xterm.js; the browser build is served as static files.

```text
  47 passed (46.4s)
  36 skipped   (the evidence-picture variants; they ran in the YAAH_UPDATE_EVIDENCE=1 pass: 83 passed)
```

`bun run test:package` (part of `bun run check`) starts the **built** command with
`node dist/cli/bin.js serve`, loads the web chat from it and talks to it over A2A:
2 pass.

## Accessibility (T9)

`bunx playwright test --grep @a11y`:

```text
  27 passed (28.4s)
```

- axe-core, WCAG 2.1 A and AA: no serious or critical violation in any web state, light
  and dark.
- Keyboard only: send → form → complete, with a visible focus indicator at each stop.
- 400 px wide: no sideways scroll.
- Terminal: the no-colour, non-TTY path prints plain lines
  (`test/integration/tui.test.ts`, "Without a TTY the interface prints plain lines").

Not done: a screen reader pass, and browsers other than Chromium.

## Pictures (T5)

Written by `YAAH_UPDATE_EVIDENCE=1 bun run test:e2e` into [`ui/`](ui/):

- `web-<state>-<light|dark|narrow>.png` — empty, streaming, waiting, tools, ask, form,
  command, hostile, completed, canceled, attachment, image.
- `tui-<state>.png` — empty, command, tools, ask, form, completed.
- `browser-completed-light.png` — the browser build after a completed task.

Compared by eye with `design/web-chat.html` and `design/tui.html`: layout, the state in
words, the boxed "Needs your input", the tool group and the composer match. Known
differences: the web tool group is open by default; the terminal draws no header line and
has no "N tools in parallel" heading; agent text is plain text, not markdown. There is no
no-colour terminal picture — that path is asserted as text.
