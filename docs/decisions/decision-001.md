# Decision 001: uv, ruff, pyright and pytest as the Python toolchain

- **Status:** accepted
- **Date:** 2026-09-13
- **Deciders:** @MadaraUchiha-314 (approver, architect)
- **Work item:** [issue #3](https://github.com/MadaraUchiha-314/yaah/issues/3)

## Context

yaah had no source tree and therefore no tooling. the-loop **detects** a repository's
tooling every session rather than reading it from configuration, and detection over an
empty repository finds nothing — so whatever the first work item writes becomes the signal
every later session reads.

Two forces met here. The owner specified the stack by name in issue #3: uv, ruff, pyright,
pytest, packaged for PyPI. Independently, the-loop's per-language fallback matrix
(`reference/tooling.md`) names exactly the same four for Python. There was no conflict to
resolve — which is itself worth recording, because it means a later session that re-derives
the defaults will land on what is already here.

## Decision

The Python toolchain is:

| Concern | Tool |
|---|---|
| Package manager | `uv`, with a committed `uv.lock` and dependencies installed to an in-repo `.venv/` |
| Build backend | `hatchling`, building the root-level `yaah/` package |
| Lint & format | `ruff` (rule set `E,W,F,I,B,UP,SIM,RUF,D`, Google docstring convention) |
| Type check | `pyright` in **strict** mode over `yaah/` and `tests/` |
| Tests | `pytest`, split into `tests/unit/` and `tests/integration/` |

Every one of these is invoked through `uv run`, so the version that runs is the version
`uv.lock` pins — in a shell, in a git hook, and in CI alike.

## Consequences

**Easier.** One manifest (`pyproject.toml`) configures four tools, because each reads it
natively. A contributor needs `uv` and nothing else: the interpreter itself is fetched
from `.python-version`. Because the same lock backs every entry point, "works on my
machine" and "works in CI" stop being different claims.

**Harder.** pyright in strict mode rejects code that a looser checker would accept —
notably runtime `isinstance` guards on annotated parameters, which `yaah/hello.py`
suppresses narrowly with a comment explaining why the guard exists. That cost is paid once
per pattern, and it is far cheaper now than retrofitting strict mode onto a codebase.

**Also.** `ruff format` reaches into `python` fenced blocks in markdown, so documentation
snippets are held to the same style as the code. The pre-commit hook was widened to
markdown to match, or `make format-check` and the hook would have disagreed.

## Alternatives considered

- **poetry + flake8 + mypy** — the previous generation of this stack. Slower, and three
  more config files. No reason to choose it for a greenfield project.
- **pip + requirements.txt** — no lock, no dependency groups, no interpreter management.
  Rejected: reproducibility is the whole point of this work item.
- **mypy instead of pyright** — a fair choice, but pyright was specified and is what the
  editor most contributors use already runs.
