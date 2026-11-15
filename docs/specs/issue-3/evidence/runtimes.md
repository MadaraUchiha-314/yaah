# Cross-runtime (T14)

| Runtime | Command | Result |
| --- | --- | --- |
| Bun 1.4.0 | `bun run test` | 1084 pass, 0 fail |
| Node 26.7.0 | `bun run test:node` (Vitest) | Tests  1015 passed (1015) |
| Node, built package | `bun run test:package` | 2 pass: `node dist/cli/bin.js serve` answers over A2A and serves the web chat |
| Node 22 and 24 | CI job "tests on Node" (added in this work item) | see the pull request's checks |

Crash recovery (T13) ran under Bun only.
