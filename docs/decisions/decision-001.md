# decision-001 — Repository toolchain

- **Status:** accepted
- **Date:** 2026-11-14
- **Work item:** [#2](https://github.com/MadaraUchiha-314/yaah/issues/2)

## Decision

| Concern                                        | Choice                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Runtime, package manager, bundler, test runner | Bun (`bun install`, `bun build`, `bun test`)                                        |
| Type declarations                              | `tsc` (TypeScript 7) with `emitDeclarationOnly` — `bun build` does not emit `.d.ts` |
| Lint                                           | oxlint with `oxlint-tsgolint` for type-aware rules                                  |
| Format                                         | oxfmt                                                                               |
| Git hooks                                      | lefthook                                                                            |
| Commit messages                                | commitlint, `@commitlint/config-conventional`                                       |
| CI                                             | GitHub Actions                                                                      |

Rollup and vitest, named as fallbacks in the ticket, were not needed.

## Strictness

- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `isolatedDeclarations`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature`.
- oxlint: `correctness`, `suspicious`, `perf` and `pedantic` categories as errors, plus
  `no-explicit-any`, the `no-unsafe-*` family, `strict-boolean-expressions`,
  `explicit-function-return-type` and `no-non-null-assertion`. `--deny-warnings` makes
  any warning fail.

## ESM only

`"type": "module"`, `module: Preserve`, and lint rules `import/no-commonjs`,
`import/no-amd`, `typescript/no-require-imports` and `unicorn/prefer-module` reject
CommonJS and AMD.

## No surprises on push

CI runs the same `bun run` scripts as the hooks: pre-commit runs format, lint, typecheck
and test; pre-push runs `bun run check`, which adds the build. Commit messages are checked
by the `commit-msg` hook locally and in CI for every commit in the PR and the PR title.
