# Specs

One directory per work item, named for its ticket id — `docs/specs/issue-<n>/` (or
`docs/specs/draft-<slug>/` before a ticket exists). The spec chain is checked in: it is
the plan of record, reviewed and approved on the ticket before code is written.

```text
docs/specs/<id>/
├── brainstorm.md      # optional — only when the work item was brainstormed
├── requirements.md    # or bugfix.md for a bug (two names for ONE artifact, never both)
├── design.md
├── design/            # optional — UI/UX artifacts (html prototypes / figma exports)
├── testing-plan.md    # authored at test-planning, completed at verification
├── tasks.md
├── evidence/          # optional — committed verification evidence
└── execution-log.md
```

Each file is scaffolded from the plugin's `skills/the-loop/templates/` by the
`/the-loop:*` commands — don't hand-roll them. Rigor scales to the change: a trivial
change does not need the full chain.

Nothing lives directly in this directory except this index.
