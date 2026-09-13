# Decision 003: commitizen for versioning, Trusted Publishing for PyPI, three workflows

- **Status:** accepted
- **Date:** 2026-09-13
- **Deciders:** @MadaraUchiha-314 (approver, architect)
- **Work item:** [issue #3](https://github.com/MadaraUchiha-314/yaah/issues/3)

## Context

Issue #3 asks for three things that turn out to be one decision: Conventional Commits
enforced by a commit linter, a release on merge to `main` that publishes `yaah` to PyPI and
writes the new version back to `main`, and a PyPI project already waiting for Trusted
Publishing under the workflow name `release.yml` and the environment `pypi`.

They are one decision because the commit format is what the version is *derived from*. Pick
a commit linter that no release tool reads, and versioning goes back to being a human
choosing a number.

The security question arrives with them. A release path holds the only privileges this
repository has — writing to `main` and authenticating to PyPI — while CI runs arbitrary code
from any fork that opens a pull request. Those two facts must not meet.

## Decision

**commitizen does both jobs.** `cz check` runs in a `commit-msg` hook, so a non-conforming
message never becomes a commit; `cz bump` reads the same commits to compute the next
version. `.cz.toml` holds the canonical version and its `version_files` keeps
`pyproject.toml` in lockstep, so a bump rewrites both in one commit and the published
distribution can never disagree with the git tag.

**Trusted Publishing, so there is no token.** The `publish-pypi` job requests a short-lived
OIDC token; PyPI verifies it came from this repository, this workflow and the `pypi`
environment, and exchanges it for upload rights that expire with the job.

**Three workflows, split along the privilege boundary** — this is the part that is a
judgement rather than a given:

| Workflow | Trigger | Permissions | Environment |
|---|---|---|---|
| `ci.yml` | `pull_request`, `push: main` | `contents: read` | none |
| `release.yml` | `push: main`, `workflow_dispatch` | `contents: read`; `contents: write` on the bump job; `id-token: write` on the publish job **only** | `pypi` on the publish job |
| `docs.yml` | `push: main` (docs paths) | `contents: read`, `pages: write`, `id-token: write` | `github-pages` on the deploy job |

A fork's pull request can execute anything it likes inside `ci.yml` and still hold nothing
worth stealing. Within `release.yml` the split continues: the job that runs commitizen over
attacker-influenced commit messages cannot authenticate to PyPI, and the job that can
cannot write to the repository.

## Consequences

**Easier.** Releasing is merging. Nobody picks a version, nobody holds a credential, and
the changelog follows from the commit log.

**Harder.** Pull-request titles become load-bearing — with squash-merge the title *is* the
commit message, so a mislabelled `feat:` ships a minor bump nobody intended. And the
release path is only exercised on `main`: verification proves the built artifact and the
workflows' shape, never an upload.

**The boundaries are tested, not promised.**
[`tests/integration/test_workflows.py`](https://github.com/MadaraUchiha-314/yaah/blob/main/tests/integration/test_workflows.py)
asserts each row of that table plus the `bump:` re-entry guard, the `concurrency` group and
the pinning of every third-party action. An edit that widens a permission turns the suite
red.

## Alternatives considered

- **One workflow with three jobs** — simpler to read, but workflow-level `permissions` are
  the ceiling for every job in the file, so the least-privilege split would have been
  weaker for no real gain.
- **A stored PyPI API token** — a long-lived credential in repository secrets, when PyPI
  offers a keyless alternative it already had configured.
- **python-semantic-release** — capable, but a second tool doing what commitizen already
  does here, and one more thing to pin.
- **A custom commit-message validator** — the-loop's rule is explicit about preferring a
  maintained library, and a regex in a hook is a regex nobody maintains.
