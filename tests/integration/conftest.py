"""Fixtures for the integration suite.

The helpers the fixtures build on live in :mod:`tests.integration._repo`, so a test can
import them directly without importing pytest's own conftest plugin module.
"""

from pathlib import Path
from typing import Any

import pytest

from tests.integration._repo import WORKFLOWS_DIR, read_yaml


@pytest.fixture(scope="session")
def workflow_paths() -> list[Path]:
    """Every checked-in workflow file."""
    paths = sorted(WORKFLOWS_DIR.glob("*.yml")) + sorted(WORKFLOWS_DIR.glob("*.yaml"))
    assert paths, f"no workflow files found under {WORKFLOWS_DIR}"
    return paths


@pytest.fixture(scope="session")
def workflows(workflow_paths: list[Path]) -> dict[str, dict[str, Any]]:
    """Every checked-in workflow, keyed by file name."""
    return {path.name: read_yaml(path) for path in workflow_paths}
