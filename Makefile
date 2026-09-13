# yaah — root task runner.
#
# RULE (the-loop, reference/tooling.md): all scripts run from the project root, and CI
# runs these same tools. Every target below is a thin wrapper over the configured
# tooling — no logic lives here — so `make check` is a one-line answer to "what does CI
# run?". Python tools enter through `uv run` and resolve from uv.lock; the docs site is
# a Node program and enters through bun.

.PHONY: help install-dev hooks lint format format-check typecheck test test-integration docs docs-dev build pre-commit check

help:
	@echo "targets:"
	@echo "  install-dev       uv sync — create .venv/ and install from uv.lock"
	@echo "  hooks             install the git hooks (pre-commit, pre-push, commit-msg)"
	@echo "  lint              ruff check + markdownlint"
	@echo "  format            ruff format (writes)"
	@echo "  format-check      ruff format --check (does not write)"
	@echo "  typecheck         pyright"
	@echo "  test              unit tests"
	@echo "  test-integration  integration tests (CI runs these; the commit hook does not)"
	@echo "  docs              build the documentation site"
	@echo "  build             build the sdist + wheel"
	@echo "  pre-commit        every hook over every file — exactly what CI's quality job runs"
	@echo "  check             lint + format-check + typecheck + test + test-integration"

install-dev:
	uv sync

hooks:
	uv run pre-commit install --install-hooks

lint:
	uv run ruff check .
	npx --yes markdownlint-cli2@0.18.1 "**/*.md"

format:
	uv run ruff format .

# CI parity: the pre-commit hook runs `ruff format`, so `check` must catch format drift too.
format-check:
	uv run ruff format --check .

typecheck:
	uv run pyright

test:
	uv run pytest tests/unit

test-integration:
	uv run pytest tests/integration

docs:
	cd docs && bun install --frozen-lockfile && bun run docs:build

docs-dev:
	cd docs && bun install && bun run docs:dev

build:
	uv build

# Everything, the way CI's quality job runs it.
pre-commit:
	uv run pre-commit run --all-files --show-diff-on-failure

check: lint format-check typecheck test test-integration
