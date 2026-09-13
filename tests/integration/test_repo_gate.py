"""The repository's own configuration, exercised as a scenario suite.

Every test carries a Gherkin docstring linking the requirement it proves
(`testing.gherkinDocstrings: required` in `.the-loop/harness-config.yaml`).
"""

import subprocess
import tomllib
from typing import Any

import pytest

from tests.integration._repo import REPO_ROOT, read_yaml

pytestmark = pytest.mark.integration


@pytest.fixture(scope="session")
def pyproject() -> dict[str, Any]:
    """The parsed root `pyproject.toml`."""
    with (REPO_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_the_package_is_importable_under_its_documented_name() -> None:
    """Check the only import form the documentation promises.

    Feature: A single importable package
      Scenario: The package is importable under its documented name
        Given the repository declares a root-level `yaah` package
        When a caller writes `from yaah import hello_world`
        Then the import resolves and the function greets

    Requirement: docs/specs/issue-3/requirements.md R1.5, R3.1
    """
    from yaah import hello_world

    assert hello_world("yaah") == "Hello, yaah!"

    package_root = REPO_ROOT / "yaah"
    assert (package_root / "__init__.py").is_file()
    # Shipping py.typed is what makes the annotations visible to a consumer's type
    # checker; without it the package is typed for us and untyped for everyone else.
    assert (package_root / "py.typed").is_file()


def test_the_distribution_is_named_yaah(pyproject: dict[str, Any]) -> None:
    """Check the published name matches the one PyPI is registered for.

    Feature: A single importable package
      Scenario: The distribution is named yaah
        Given the release workflow publishes to PyPI under a project name
        When the root pyproject.toml is read
        Then the distribution is named `yaah` and builds from the `yaah` package

    Requirement: docs/specs/issue-3/requirements.md R1.3, R7.5
    """
    assert pyproject["project"]["name"] == "yaah"
    wheel = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert wheel["packages"] == ["yaah"]


def test_the_pinned_toolchain_resolves_from_the_committed_lock(
    pyproject: dict[str, Any],
) -> None:
    """Check the lock and the interpreter pin are both committed and consistent.

    Feature: Reproducible toolchain
      Scenario: The pinned toolchain resolves from the committed lock
        Given uv.lock and .python-version are checked in
        When a contributor or a CI job syncs the environment
        Then both resolve the same interpreter and the same dependency versions

    Requirement: docs/specs/issue-3/requirements.md R1.2, R1.4, R2.5
    """
    lock = REPO_ROOT / "uv.lock"
    assert lock.is_file(), "uv.lock must be committed — it is what makes local == CI"
    assert 'name = "yaah"' in lock.read_text(encoding="utf-8")

    pinned = (REPO_ROOT / ".python-version").read_text(encoding="utf-8").strip()
    requires = pyproject["project"]["requires-python"]
    assert requires.startswith(">="), f"unexpected requires-python form: {requires}"
    floor = requires.removeprefix(">=").strip()
    # The pin must satisfy the floor, or `uv sync` and the published metadata disagree
    # about which interpreters this project supports.
    assert tuple(int(part) for part in pinned.split(".")) >= tuple(
        int(part) for part in floor.split(".")
    ), f".python-version ({pinned}) is below requires-python ({requires})"


def test_every_configured_tool_is_wired_into_the_gate() -> None:
    """Check the hook file defines the whole gate, since CI runs exactly it.

    Feature: One gate, referenced everywhere
      Scenario: The repository's own quality gate covers every configured tool
        Given CI's quality job runs `pre-commit run --all-files` and nothing else
        When the hook definitions are read
        Then ruff, pyright, pytest, markdownlint and commitizen are all present
        And each Python tool enters through `uv run` so uv.lock decides its version

    Requirement: docs/specs/issue-3/requirements.md R2.1-R2.5, R5.2, R5.4
    """
    config = read_yaml(REPO_ROOT / ".pre-commit-config.yaml")

    hooks: dict[str, dict[str, Any]] = {}
    for repo in config["repos"]:
        for hook in repo["hooks"]:
            hooks[str(hook["id"])] = hook

    for expected in ("ruff-lint", "ruff-format", "pyright", "pytest-unit"):
        assert expected in hooks, f"{expected} is not part of the gate"
    # Markdown is linted like code, or it rots like prose.
    assert "markdownlint" in hooks

    for hook_id in ("ruff-lint", "ruff-format", "pyright", "pytest-unit", "commitizen"):
        entry = str(hooks[hook_id]["entry"])
        assert entry.startswith("uv run "), (
            f"{hook_id} does not enter through `uv run`, so its version is whatever is "
            f"on PATH rather than what uv.lock pins: {entry!r}"
        )

    # The commit-msg stage is what enforces Conventional Commits; a hook that ran at the
    # default stage would never see a commit message.
    assert hooks["commitizen"]["stages"] == ["commit-msg"]
    assert set(config["default_install_hook_types"]) == {
        "pre-commit",
        "pre-push",
        "commit-msg",
    }


def test_integration_tests_are_not_a_commit_hook() -> None:
    """Check the commit path stays fast, by design rather than by luck.

    Feature: One gate, referenced everywhere
      Scenario: Integration tests run in CI but not on every commit
        Given hooks must stay fast enough that contributors leave them installed
        When the hook definitions are read
        Then no hook runs the integration suite
        And CI runs it as a job of its own

    Requirement: docs/specs/issue-3/requirements.md R6.2
    """
    config = read_yaml(REPO_ROOT / ".pre-commit-config.yaml")
    entries = [str(hook["entry"]) for repo in config["repos"] for hook in repo["hooks"]]
    assert not any("tests/integration" in entry for entry in entries)

    ci = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "tests/integration" in ci, "CI must run what the commit hook does not"


def test_the_documentation_site_is_rooted_at_docs() -> None:
    """Check the site is configured for the path GitHub Pages actually serves.

    Feature: A published documentation site
      Scenario: The documentation site builds from docs/ with a generated specs sidebar
        Given the site is deployed to https://madarauchiha-314.github.io/yaah/
        When the VitePress configuration is read
        Then its base path is `/yaah/`
        And the specs sidebar is generated from the filesystem rather than hand-listed

    Requirement: docs/specs/issue-3/requirements.md R8.1, R8.2, R8.6
    """
    package = REPO_ROOT / "docs" / "package.json"
    assert package.is_file()
    assert "docs:build" in package.read_text(encoding="utf-8")

    config = (REPO_ROOT / "docs" / ".vitepress" / "config.mts").read_text(
        encoding="utf-8"
    )
    assert 'base: "/yaah/"' in config
    # R8.6: a new spec directory must appear without a manual nav edit, which is only
    # true while the sidebar is read off the filesystem.
    assert "readdirSync" in config
    assert "specs" in config


def test_every_markdown_document_lives_under_docs() -> None:
    """Check documentation has one home, so the site cannot miss half of it.

    Feature: A published documentation site
      Scenario: Project documentation lives under docs/
        Given issue #3 asks for all project documentation to reside in docs/
        When the repository's tracked markdown is listed
        Then only the repository's entry-point files sit outside docs/

    Requirement: docs/specs/issue-3/requirements.md R8.1
    """
    # git ls-files rather than rglob: the question is what the repository *contains*,
    # and a tool cache that happens to ship a README is not documentation.
    tracked = subprocess.run(
        ["git", "ls-files", "*.md"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert tracked, "git ls-files found no markdown at all"

    allowed_at_root = {"README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md"}
    stray = [
        name
        for name in tracked
        if not name.startswith("docs/") and name not in allowed_at_root
    ]
    assert not stray, f"markdown outside docs/: {stray}"
