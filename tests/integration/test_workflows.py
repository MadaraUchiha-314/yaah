"""The security invariants of `design.md` § Security design, as tests.

Each abuse case (A1-A6) in the work item's threat model is defended by a mechanism in a
workflow file. A mechanism nobody checks is a comment, so each one gets a negative test
here: an edit that grants CI a publish credential, widens the release job's permissions
or un-pins an action turns this suite red.
"""

import re
from pathlib import Path
from typing import Any

import pytest

from tests.integration._repo import jobs, needs, permissions, steps, triggers

pytestmark = pytest.mark.integration

# Every permission that can mint or spend a credential, rather than merely read.
PRIVILEGED_PERMISSIONS = {"id-token", "contents", "packages", "pages", "deployments"}

# `${{ ... }}` interpolations whose value an untrusted contributor controls. Inside a
# `run:` block these are pasted into the shell before it executes — the classic GitHub
# Actions script-injection sink.
UNTRUSTED_EXPRESSIONS = re.compile(
    r"\$\{\{\s*(github\.event\b|github\.head_ref\b|github\.actor\b|"
    r"github\.triggering_actor\b|inputs\.)"
)


def test_ci_workflow_holds_no_publish_credentials(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A1 — a fork's pull request executes arbitrary code in CI.

    Feature: Least-privilege CI
      Scenario: CI holds no publish credential
        Given ci.yml executes code from an untrusted pull-request branch
        When its permissions and environment bindings are read
        Then it requests no `id-token` permission at any scope
        And it binds no deployment environment
        And its workflow-level permissions are read-only

    Requirement: docs/specs/issue-3/requirements.md R6, R7.6
    """
    ci = workflows["ci.yml"]

    assert "id-token" not in permissions(ci)
    assert permissions(ci) == {"contents": "read"}, (
        "ci.yml must declare read-only workflow permissions explicitly; the "
        "repository default is not a guarantee"
    )

    for name, job in jobs(ci).items():
        assert "id-token" not in permissions(job), f"job {name} requests an OIDC token"
        assert "environment" not in job, (
            f"job {name} binds a deployment environment, which is where environment "
            f"secrets and protection rules live"
        )


def test_no_workflow_uses_pull_request_target(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A2 — untrusted branch code running with a write-scoped token.

    Feature: Least-privilege CI
      Scenario: No workflow runs untrusted branch code with a write-scoped token
        Given `pull_request_target` runs a fork's branch with the base repository's
          secrets and a write-capable token
        When every workflow's triggers are read
        Then none of them uses `pull_request_target`

    Requirement: docs/specs/issue-3/requirements.md R6.1
    """
    for name, workflow in workflows.items():
        assert "pull_request_target" not in triggers(workflow), (
            f"{name} uses pull_request_target"
        )


def test_release_scopes_privileges_per_job(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A3 — a release credential reaching more than the job that needs it.

    Feature: Least-privilege releases
      Scenario: Release privileges are scoped per job
        Given the release workflow both writes to main and publishes to PyPI
        When its permissions are read
        Then the workflow-level default is read-only
        And only the version-bump job may write repository contents
        And only the publish job may mint an OIDC token, bound to the `pypi` environment

    Requirement: docs/specs/issue-3/requirements.md R7.5, R7.6
    """
    release = workflows["release.yml"]

    top = permissions(release)
    assert top == {"contents": "read"}, (
        "workflow-level permissions must be read-only; privileges belong on the jobs "
        f"that need them, got {top}"
    )

    release_jobs = jobs(release)
    bump = release_jobs["release"]
    publish = release_jobs["publish-pypi"]

    assert permissions(bump).get("contents") == "write"
    assert "id-token" not in permissions(bump), (
        "the bump job must not be able to authenticate to PyPI: it is the job that "
        "runs commitizen over untrusted commit messages"
    )
    assert "environment" not in bump

    assert permissions(publish).get("id-token") == "write"
    assert permissions(publish).get("contents", "read") == "read"
    environment = publish["environment"]
    assert isinstance(environment, dict) and environment["name"] == "pypi"

    # The publish job must depend on the bump job's verdict, or a distribution could be
    # published for a release that was never cut.
    assert needs(publish) == ["release"]
    assert "needs.release.outputs.released" in str(publish["if"])


def test_no_workflow_interpolates_untrusted_input_into_a_shell(
    workflow_paths: list[Path],
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A4 — script injection through a commit message or branch name.

    Feature: Least-privilege CI
      Scenario: No workflow interpolates untrusted input into a shell
        Given a commit message and a branch name are attacker-controlled text
        When every `run:` block in every workflow is read
        Then none of them interpolates a `github.event`, `github.head_ref`,
          `github.actor` or `inputs.` expression

    Requirement: docs/specs/issue-3/requirements.md R7 (abuse case A4)
    """
    offenders: list[str] = []
    for path in workflow_paths:
        for job_name, job in jobs(workflows[path.name]).items():
            for index, step in enumerate(steps(job)):
                script = step.get("run")
                if not isinstance(script, str):
                    continue
                if UNTRUSTED_EXPRESSIONS.search(script):
                    offenders.append(f"{path.name}:{job_name}:step[{index}]")
    assert not offenders, (
        "these run: blocks paste attacker-controlled text into a shell; pass the "
        f"value through an env: mapping and quote it instead: {offenders}"
    )


def test_every_action_reference_is_pinned(
    workflow_paths: list[Path],
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A5 — an unpinned third-party action in the release path.

    Feature: Reproducible, auditable automation
      Scenario: Every third-party action reference is pinned
        Given an unpinned action resolves to whatever its default branch holds today
        When every `uses:` in every workflow is read
        Then each one carries an explicit ref after `@`

    Requirement: docs/specs/issue-3/requirements.md R7 (abuse case A5)
    """
    unpinned: list[str] = []
    for path in workflow_paths:
        for job_name, job in jobs(workflows[path.name]).items():
            for step in steps(job):
                uses = step.get("uses")
                if not isinstance(uses, str):
                    continue
                ref = uses.partition("@")[2]
                if not ref:
                    unpinned.append(f"{path.name}:{job_name}: {uses}")
    assert not unpinned, f"unpinned action references: {unpinned}"


def test_release_does_not_re_enter_on_its_own_bump_commit(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """Abuse case A6 — the release workflow triggering itself, forever.

    Feature: Reproducible, auditable automation
      Scenario: The release does not re-enter on its own bump commit
        Given the release pushes its version bump back to main
        And a push to main is what triggers the release
        When the workflow is read
        Then the release job is guarded against its own `bump:` commit
        And concurrency prevents two releases racing on the tag

    Requirement: docs/specs/issue-3/requirements.md R7.3, R7.4
    """
    release = workflows["release.yml"]

    guard = str(jobs(release)["release"]["if"])
    assert "bump:" in guard and "head_commit.message" in guard

    concurrency = release["concurrency"]
    assert isinstance(concurrency, dict)
    assert concurrency["group"] == "release"
    assert concurrency["cancel-in-progress"] is False, (
        "cancelling an in-flight release would abandon a pushed tag mid-publish"
    )


def test_ci_runs_the_same_gate_a_contributor_runs(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """The point of the work item: one gate, referenced rather than re-implemented.

    Feature: One gate, referenced everywhere
      Scenario: CI runs the contributor's own hooks plus the integration suite
        Given a contributor's commit runs `pre-commit`
        When CI's jobs are read
        Then a job runs `pre-commit run --all-files`
        And another job runs the integration suite
        And another builds the documentation site

    Requirement: docs/specs/issue-3/requirements.md R6.1, R6.2, R6.4
    """
    scripts = [
        str(step.get("run", ""))
        for job in jobs(workflows["ci.yml"]).values()
        for step in steps(job)
    ]
    joined = "\n".join(scripts)

    assert "pre-commit run --all-files" in joined
    assert "pytest tests/integration" in joined
    assert "docs:build" in joined


def test_ci_pins_the_interpreter_to_the_repository_pin(
    workflows: dict[str, dict[str, Any]],
) -> None:
    """A CI interpreter chosen independently is drift waiting to happen.

    Feature: Reproducible toolchain
      Scenario: CI resolves the interpreter from .python-version
        Given .python-version is the repository's single interpreter pin
        When CI's uv setup step is read
        Then it reads that file rather than naming a version of its own

    Requirement: docs/specs/issue-3/requirements.md R1.4, R2.5
    """
    for name in ("ci.yml", "release.yml"):
        setup_steps = [
            step
            for job in jobs(workflows[name]).values()
            for step in steps(job)
            if str(step.get("uses", "")).startswith("astral-sh/setup-uv@")
        ]
        assert setup_steps, f"{name} does not set up uv"
        for step in setup_steps:
            with_block: object = step.get("with", {})
            assert isinstance(with_block, dict)
            assert "python-version" not in with_block, (
                f"{name} names a Python version of its own; it must read "
                f".python-version so CI and local cannot diverge"
            )
