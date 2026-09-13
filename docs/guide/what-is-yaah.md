# What is yaah?

**yaah — Yet Another Agent Harness — is a Python package in the earliest stage of its
life: the toolchain is built, the product is not.** Today it exposes exactly one
function. What it already has is the machinery that will carry everything after it — a
pinned toolchain, a quality gate wired identically into git hooks and CI, an automated
release to PyPI, and this documentation site.

That order is deliberate. yaah develops itself through
[the-loop](https://github.com/MadaraUchiha-314/the-loop), a product-development-lifecycle
harness in which every change is a work item with a checked-in spec chain. A harness that
cannot lint, test, type-check, release and document its own code cannot be trusted to run
a process about doing those things.

## What exists today

```python
from yaah import hello_world

hello_world()  # 'Hello, World!'
hello_world("yaah")  # 'Hello, yaah!'
```

That is the whole public surface. It exists so the build, the tests, the type checker and
the publish path all have real code to carry rather than an empty package.

## How the project works

Every change starts as a GitHub issue and becomes a directory under
[`docs/specs/`](/specs/): requirements, design, a testing plan, a task DAG and an
execution log, all reviewed before code is written. The organized view of what the
project currently *does* lives in [capabilities](/capabilities/capabilities); the reasons
behind how it is built live in [decisions](/decisions/decisions).

## Where to go next

| If you want to… | Read |
|---|---|
| know which tools the project uses and why | [Tech stack](/guide/tech-stack) |
| get a working environment | [Local development](/guide/local-development) |
| open a pull request | [Contributing](/guide/contributing) |
| understand how a version reaches PyPI | [Releases](/guide/releases) |
| see the shape of the system | [Architecture](/architecture/architecture) |
