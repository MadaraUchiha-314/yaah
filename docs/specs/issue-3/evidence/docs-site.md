# Evidence — T5 · the documentation site builds and renders

Requirement R8. Run on 2026-09-13.

**Outcome: the site builds clean and renders.** Screenshots of three representative
pages are committed beside this file.

| Screenshot | Page | What it shows |
|---|---|---|
| [`ui/home.png`](ui/home.png) | `/yaah/` | the home page, nav, and the three feature cards |
| [`ui/tech-stack.png`](ui/tech-stack.png) | `/yaah/guide/tech-stack` | the tool matrix and a rendered mermaid diagram |
| [`ui/local-development.png`](ui/local-development.png) | `/yaah/guide/local-development` | the contributor instructions, including installing the git hooks |
| [`ui/spec-page.png`](ui/spec-page.png) | `/yaah/specs/issue-3/design` | this work item's own design, reached through the **generated** specs sidebar (R8.6) |

## A finding this activity caught

The first capture of the home page rendered the theme's own chrome as literal
`{ { site.title } }` text. The cause was a repository-wide Vue delimiter override added to
stop GitHub Actions expressions in prose from being evaluated — it also disabled
interpolation inside VitePress's default theme components. **The build reported success
either way**, which is why the screenshots are part of the plan rather than an optional
extra. The override was replaced by putting the one offending expression in a fenced code
block, and by `docs/scripts/build.mjs`, which fails the build when VitePress logs a
rendering error and exits 0 anyway.

## `cd docs && bun run docs:build`

```text
$ node scripts/build.mjs

  vitepress v1.6.4

- building client + server bundles...
[32m✓[0m building client + server bundles...
- rendering pages...
[32m✓[0m rendering pages...
build complete in 3.80s.
```
