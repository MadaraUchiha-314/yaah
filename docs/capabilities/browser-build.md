# Capability: The browser build

> The whole harness in a browser tab, with no yaah server.

## What it is

`bun run build:browser` produces a static site in `dist/browser/`: the kernel, the core loop, in-memory stores, the A2A request handling, the model providers and the web chat. The chat reaches the harness through an in-memory A2A transport onto the same request handler, so no request leaves the tab except to the model provider.

## Current behaviour

- The system SHALL provide the composition `browser.yml`, in which every plugin that needs Node is replaced (prompts, the core's stores, the harness target) or left out (the HTTP listener, logging and tracing, A2UI validation, skills, agent plugins, Temporal).
- WHEN the browser build runs THEN it SHALL complete a multi-turn, long-running task against a configured model with no yaah process.
- IF a plugin that declares it needs Node, or whose imports reach a Node or Bun built-in, is configured into the browser build THEN the build SHALL fail naming the entry and the module.
- The page SHALL read its configuration from `config.toml` beside `index.html`, or from `globalThis.yaah` set by an embedding page; `createBrowserHarness(options)` is exported for applications.
- A credential given to the page is readable by whoever uses that browser. The shipped configuration holds none: point `base_url` of an OpenAI-compatible endpoint at a backend of your own.

## Design

- [design.md — Composition (browser)](../specs/issue-3/design.md#composition)
- `src/browser/`, `scripts/build-browser.ts`
- Known gaps: no A2UI and no logging in the tab; exercised against a stubbed model endpoint in Chromium only.

## History

| Work item | What changed | Links                             |
| --------- | ------------ | --------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), PR #13 |
