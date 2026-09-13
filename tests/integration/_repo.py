"""Helpers for reading the repository's own configuration.

These tests assert on the **repository itself** — its manifests, its hook definitions
and its workflow files — because most of what issue #3 delivers is configuration.
Executing that configuration is what the verification activities do; asserting on its
shape is how the invariants that must not silently regress (the security boundaries of
``design.md`` § Security design) become a suite that turns red.

YAML arrives untyped, so every accessor below narrows once, here, and hands the tests a
concrete mapping. That keeps `# pyright: ignore` out of the tests themselves, where it
would be easy to mistake for a finding someone waved away.
"""

from pathlib import Path
from typing import Any, cast

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"


def as_mapping(value: object, what: str) -> dict[str, Any]:
    """Narrow an untyped YAML node to a string-keyed mapping."""
    assert isinstance(value, dict), f"{what} is not a mapping"
    mapping = cast(dict[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def as_list(value: object, what: str) -> list[Any]:
    """Narrow an untyped YAML node to a list."""
    assert isinstance(value, list), f"{what} is not a list"
    return cast(list[Any], value)


def read_yaml(path: Path) -> dict[str, Any]:
    """Parse a YAML file into a mapping."""
    return as_mapping(yaml.safe_load(path.read_text(encoding="utf-8")), str(path))


def triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    """Return a workflow's ``on:`` block.

    PyYAML resolves the bare key ``on`` to the boolean ``True`` (YAML 1.1 treats it as a
    truthy token), so the block has to be looked up under both spellings.
    """
    raw: dict[Any, Any] = workflow
    block: object = raw.get("on", raw.get(True))
    if block is None:
        return {}
    if isinstance(block, str):
        return {block: None}
    if isinstance(block, list):
        return dict.fromkeys(str(item) for item in cast(list[Any], block))
    return as_mapping(block, "`on:`")


def jobs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Return a workflow's jobs, keyed by job id."""
    block = as_mapping(workflow.get("jobs", {}), "`jobs:`")
    return {name: as_mapping(job, f"job {name}") for name, job in block.items()}


def steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a job's steps."""
    block = as_list(job.get("steps", []), "`steps:`")
    return [as_mapping(step, "a step") for step in block]


def permissions(scope: dict[str, Any]) -> dict[str, str]:
    """Return a workflow-level or job-level ``permissions:`` block."""
    block: object = scope.get("permissions", {})
    if block is None or isinstance(block, str):
        return {}
    return {
        name: str(value) for name, value in as_mapping(block, "`permissions:`").items()
    }


def needs(job: dict[str, Any]) -> list[str]:
    """Return a job's ``needs:`` as a list."""
    block: object = job.get("needs", [])
    if isinstance(block, str):
        return [block]
    return [str(item) for item in as_list(block, "`needs:`")]
