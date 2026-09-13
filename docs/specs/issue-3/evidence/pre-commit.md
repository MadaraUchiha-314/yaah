# Evidence — T2 · the full hook set over every file

The identical command CI's `quality` job runs (`.github/workflows/ci.yml`). Run on
2026-09-13.

**Outcome: every hook passed.**

## `uv run pre-commit run --all-files --show-diff-on-failure`

```text
ruff (lint + autofix)....................................................Passed
ruff (format)............................................................Passed
pyright (type check).....................................................Passed
pytest (unit tests)......................................................Passed
markdownlint (all markdown, incl. docs)..................................Passed
```
