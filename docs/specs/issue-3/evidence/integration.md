# Evidence — T2 · integration suite (with T8's abuse cases)

Requirements R1, R2, R3.5, R3.6, R5, R6, R8 and the abuse cases A1-A6 of
`design.md` § Security design. Run on 2026-09-13.

**Outcome: 15 passed.** Every test carries a Gherkin docstring naming its scenario and
the requirement it proves, per `testing.gherkinDocstrings: required`.

## `uv run pytest tests/integration -v`

```text
============================= test session starts ==============================
platform linux -- Python 3.13.12, pytest-9.1.1, pluggy-1.6.0
rootdir: .
configfile: pyproject.toml
collected 15 items

tests/integration/test_repo_gate.py .......                              [ 46%]
tests/integration/test_workflows.py ........                             [100%]

============================== 15 passed in 0.04s ==============================
```
