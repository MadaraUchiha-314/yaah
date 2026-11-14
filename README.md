# yaah

Yet Another Agent Harness!

## Development

Requires [Bun](https://bun.sh) ≥ 1.4. Everything is TypeScript, ESM-only.

```sh
bun install        # installs deps and the git hooks (lefthook)
bun run check      # everything CI runs: format, lint, typecheck, test, build
```

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `bun run build`     | Bundles `src/` with `bun build`, emits `.d.ts` |
| `bun run test`      | `bun test` with coverage (90% lines/functions) |
| `bun run lint`      | `oxlint` with type-aware rules, warnings fail  |
| `bun run format`    | `oxfmt` (use `format:check` to verify only)    |
| `bun run typecheck` | `tsc --noEmit` under a strict `tsconfig.json`  |

Git hooks (`lefthook.yml`) mirror CI (`.github/workflows/ci.yml`):

- **pre-commit** — format check, lint, typecheck, test.
- **commit-msg** — [commitlint](https://commitlint.js.org) with the Conventional Commits preset.
- **pre-push** — `bun run check` (adds the build).

CI also lints every commit in a pull request and the PR title.
