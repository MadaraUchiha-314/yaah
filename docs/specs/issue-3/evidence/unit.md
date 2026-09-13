# Evidence — T1 · unit tests

Requirement R3 (`hello_world` and its input validation). Run on 2026-09-13 against the
branch `claude/github-issue-3-3lm0oe`.

**Outcome: 9 passed.** The four rejection cases are the abuse-case A7 negatives — a
non-`str` argument and a blank name both raise rather than returning a greeting.

## `uv run pytest tests/unit -v`

```text
============================= test session starts ==============================
platform linux -- Python 3.13.12, pytest-9.1.1, pluggy-1.6.0
rootdir: .
configfile: pyproject.toml
collected 9 items

tests/unit/test_hello.py .........                                       [100%]

============================== 9 passed in 0.02s ===============================
```
