# Local development

**Three commands take a clone to a verified environment**, and the third is the same
command CI runs:

```bash
uv sync          # create .venv/ and install everything from uv.lock
make hooks       # install the git hooks — do this once, per clone
make check       # lint, format-check, typecheck, unit tests, integration tests
```

If `make check` is green, CI will be too. That is the whole design: the checks are defined
once in `.pre-commit-config.yaml`, and your hooks, `make`, and CI all reference that one
definition.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | the Python package manager; it also downloads the pinned interpreter | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node.js 22+ | `npx` runs the markdown linter | [nodejs.org](https://nodejs.org/) |
| [bun](https://bun.sh/) | builds the documentation site | `curl -fsSL https://bun.sh/install \| bash` |

You do **not** need to install Python yourself. `.python-version` pins the interpreter and
`uv sync` fetches it.

## Setting up

```bash
git clone https://github.com/MadaraUchiha-314/yaah.git
cd yaah
uv sync
```

`uv sync` creates `.venv/` **inside the repository** and installs the project plus its dev
dependency group from `uv.lock`. Nothing is installed globally, and everyone gets the same
versions.

## Installing the git hooks

**Do this once per clone — it is the step that makes the gate yours rather than CI's.**

```bash
make hooks          # == uv run pre-commit install --install-hooks
```

That installs three hook types in one go:

| Hook type | Runs | When |
|---|---|---|
| `pre-commit` | ruff lint + format, pyright, unit tests, markdownlint | `git commit` |
| `pre-push` | the same set | `git push` |
| `commit-msg` | `cz check` — Conventional Commits | `git commit` |

To check the installation, or to run the hooks over the whole repository without
committing:

```bash
make pre-commit     # == uv run pre-commit run --all-files --show-diff-on-failure
```

Integration tests are deliberately **not** a hook. They read the repository's whole
configuration and belong in CI; hooks have to stay fast enough that you leave them
installed.

## The everyday commands

```bash
make help             # list every target
make lint             # ruff check + markdownlint
make format           # ruff format (writes)
make typecheck        # pyright
make test             # unit tests
make test-integration # integration tests
make check            # everything above, in CI's order
make build            # build the sdist + wheel
```

Every Python target enters through `uv run`, so the tool that runs is the one `uv.lock`
pins — never whatever happens to be on your `PATH`.

## Writing a commit

Commit messages follow
[Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), enforced by
the `commit-msg` hook. The type is what decides the next release, so it is a statement
about impact rather than a label:

```text
feat: add the thing        -> next release bumps the minor version
fix: stop the crash        -> next release bumps the patch version
feat!: change the API      -> next release bumps the major version
docs: explain the thing    -> no release
```

A message that does not match is rejected before it becomes a commit. `uv run cz commit`
walks you through the format interactively if you would rather not remember it.

## Working on the documentation

The site is VitePress, rooted at `docs/`:

```bash
make docs-dev     # live-reloading dev server
make docs         # the production build CI runs
```

Every markdown file under `docs/` is a page, including the checked-in specs, decisions and
learnings. Markdown is linted like code — `make lint` covers it.

## Running against the package

```bash
uv run python -c "from yaah import hello_world; print(hello_world('you'))"
```

## When something fails

| Symptom | Cause | Fix |
|---|---|---|
| `uv sync --locked` fails in CI but `uv sync` works locally | `pyproject.toml` changed without re-locking | run `uv sync` and commit the updated `uv.lock` |
| a hook runs a version you did not expect | the tool was invoked directly instead of through `uv run` | use the `make` target |
| `cz check` rejects a message you think is fine | the type is not one commitizen knows | see the list above; `build`, `ci`, `chore`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` and `test` are valid |
| markdownlint fails on a file you did not touch | a rule applies repository-wide | fix it, or argue the rule in `.markdownlint-cli2.jsonc` — with a comment saying why |
