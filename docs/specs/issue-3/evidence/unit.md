# Unit tests (T1, T6, T15)

Run on 2026-11-14 at commit `b3deea5` (branch `issue-3-8-extensibility`), Bun 1.4.0, Node 26.7.0, Linux x64.

`bun run test:unit` — pure logic beside the source: the plan, compaction, context
rendering, configuration, step keys, the redactor, the terminal filter, extension schemas,
the task-state table, strings and locales.

```text
 643 pass
 0 fail
 2078 expect() calls
Ran 643 tests across 75 files. [4.98s]
```

Coverage over the whole `bun run test` run (unit, contract, integration, security), with
the gate at 90% lines and functions **per file**:

```text
All files                                                  |   99.29 |   99.54 |
```

- **T6 (snapshots).** The plan named snapshot files. What exists instead are tests that
  assert the rendered context, the terminal frames, the agent card and the default
  `config.toml` against explicit expected text in the test, plus the generated contracts
  under `specs/`, compared byte for byte (see `contract.md`). No `.snap` files are used.
- **T15 (strings).** `src/kernel/strings.test.ts`: a second locale with a key missing
  falls back to `en`; an unknown locale falls back whole.
