# Evidence — T8 · security / abuse cases

One negative test per trust boundary in `design.md` § Security design. Run on 2026-09-13.

**Outcome: 8 passed.**

| Abuse case | Test | What it would catch |
|---|---|---|
| A1 — a fork's pull request reaches a publish credential | `test_ci_workflow_holds_no_publish_credentials` | an `id-token` permission or an `environment:` binding appearing in `ci.yml` |
| A2 — untrusted branch code runs with a write token | `test_no_workflow_uses_pull_request_target` | a switch to `pull_request_target` |
| A3 — a release credential reaches more than one job | `test_release_scopes_privileges_per_job` | `id-token: write` moved to the workflow level, or the bump job gaining PyPI access |
| A4 — script injection via a commit message | `test_no_workflow_interpolates_untrusted_input_into_a_shell` | a `run:` block interpolating `github.event`, `github.head_ref`, `github.actor` or `inputs.` |
| A5 — an unpinned third-party action | `test_every_action_reference_is_pinned` | a `uses:` without an `@ref` |
| A6 — the release triggering itself forever | `test_release_does_not_re_enter_on_its_own_bump_commit` | removal of the `bump:` guard or of `concurrency: release` |
| — (gate integrity) | `test_ci_runs_the_same_gate_a_contributor_runs` | CI drifting away from the hook set |
| — (gate integrity) | `test_ci_pins_the_interpreter_to_the_repository_pin` | CI naming a Python version of its own |

## `uv run pytest tests/integration/test_workflows.py -v`

```text
============================= test session starts ==============================
platform linux -- Python 3.13.12, pytest-9.1.1, pluggy-1.6.0
rootdir: .
configfile: pyproject.toml
collected 8 items

tests/integration/test_workflows.py ........                             [100%]

============================== 8 passed in 0.03s ===============================
```
