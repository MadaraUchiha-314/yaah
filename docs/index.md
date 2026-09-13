---
layout: home

hero:
  name: yaah
  text: Yet Another Agent Harness
  tagline: >-
    A Python project that develops itself through the-loop — every change a work item,
    every work item a spec chain, every spec chain checked in and published here.
  actions:
    - theme: brand
      text: What is yaah?
      link: /guide/what-is-yaah
    - theme: alt
      text: Local development
      link: /guide/local-development
    - theme: alt
      text: View on GitHub
      link: https://github.com/MadaraUchiha-314/yaah

features:
  - title: One gate, referenced everywhere
    details: >-
      Lint, format, type checks and unit tests are defined once as pre-commit hooks. The
      git hooks run them, "make check" runs them, and CI runs literally the same command,
      so "it passed locally" and "it passed in CI" cannot disagree — there is only one
      list.
    link: /guide/tech-stack
    linkText: The tech stack
  - title: Releasing is a consequence of merging
    details: >-
      Commit messages are Conventional Commits, enforced by commitizen. A merge to main
      derives the next version from them, tags it, pushes it back, and publishes to PyPI
      over OIDC — no stored token anywhere.
    link: /guide/releases
    linkText: How releases work
  - title: The paper trail is the documentation
    details: >-
      Requirements, design, testing plans, decisions and learnings are checked in beside
      the code and published as pages of this site. A decision nobody can find is a
      decision that gets made again.
    link: /specs/
    linkText: Browse the specs
---
