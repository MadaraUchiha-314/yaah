# Evidence — T11 · manual exploratory

Requirements R1.1, R4.1 and R5.1 — the contributor-facing path exactly as
`docs/guide/local-development.md` describes it. Run on 2026-09-13.

## Clean bootstrap

`.venv/` was deleted first, so this is the path a fresh clone takes.

**Outcome: `uv sync` → `make hooks` → `make check` all green.**

## `uv sync && make hooks && make check`

```text
$ uv sync
Resolved 34 packages in 4ms
Audited 34 packages in 0.63ms

$ make hooks
pre-commit installed at .git/hooks/pre-commit
pre-commit installed at .git/hooks/pre-push
pre-commit installed at .git/hooks/commit-msg

$ make check
uv run ruff check .
All checks passed!
npx --yes markdownlint-cli2@0.18.1 "**/*.md"
markdownlint-cli2 v0.18.1 (markdownlint v0.38.0)
Finding: **/*.md !**/node_modules/** !**/.venv/** !docs/.vitepress/dist/** !docs/.vitepress/cache/**
Linting: 21 file(s)
Summary: 0 error(s)
uv run ruff format --check .
30 files already formatted
uv run pyright
0 errors, 0 warnings, 0 informations
uv run pytest tests/unit
.........                                                                [100%]
9 passed in 0.01s
uv run pytest tests/integration
...............                                                          [100%]
15 passed in 0.04s
```

## The commit-msg hook rejects a non-conventional message

**Outcome: the commit was refused.** commitizen's own pattern is printed, so the
contributor is told what was expected rather than merely that something was wrong. The
staged changes were then committed with a conforming message.

## `git commit -m "wire up the repo tooling"`

```text
$ git commit -m "wire up the repo tooling"
ruff (lint + autofix)....................................................Passed
ruff (format)............................................................Passed
pyright (type check).....................................................Passed
pytest (unit tests)......................................................Passed
markdownlint (all markdown, incl. docs)..................................Passed
ruff (lint + autofix)................................(no files to check)Skipped
ruff (format)........................................(no files to check)Skipped
pyright (type check).................................(no files to check)Skipped
pytest (unit tests)..................................(no files to check)Skipped
markdownlint (all markdown, incl. docs)..............(no files to check)Skipped
Conventional Commits (commitizen)........................................Failed
- hook id: commitizen
- exit code: 14

commit validation: failed!
please enter a commit message in the commitizen format.
commit "": "wire up the repo tooling
"pattern: (?s)(build|bump|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(\S+\))?!?: ([^\n\r]+)((\n\n.*)|(\s*))?$

exit=0
```
