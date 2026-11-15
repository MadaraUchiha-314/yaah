# Contract tests (T3)

Run on 2026-11-14 at commit `b3deea5` (branch `issue-3-8-extensibility`), Bun 1.4.0, Node 26.7.0, Linux x64.

`bun run test:contract` — the contract suites (`llmContract`, `persistenceContract`,
`durableContract`, `systemOneContract`, the speech contracts, `rendererContract`) against
every shipped implementation, and the checked-in contracts under `specs/` against what
the source generates.

```text
 237 pass
 0 fail
 550 expect() calls
Ran 237 tests across 16 files. [15.71s]
```

| Suite | Implementations it ran against |
| --- | --- |
| `llmContract` | scripted; OpenAI (Responses, recorded from `gpt-6.1-sol`); Anthropic (recorded); OpenAI-compatible (Chat Completions, recorded from `gpt-4.1-mini`) |
| `persistenceContract` | in-memory; SQLite |
| `durableContract` | in-process (`none`); embedded Temporal |
| `systemOneContract` | scripted; OpenAI Decisions (**hand-written fixtures** — not yet recorded from the live API) |
| speech contracts | scripted; OpenAI transcription and Realtime speech (**hand-written fixtures**) |
| `rendererContract` | terminal UI; web UI |
| `specs/` | configuration schema, eight A2A extension schemas, the hooks schema, `specs/api/exports.json` |

There is no `toolContract`: the testing plan named one, and tools are covered by
`src/harness/tools/execute.test.ts` and the MCP integration tests instead.
