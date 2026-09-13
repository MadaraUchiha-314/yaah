# CLAUDE.md — working in yaah

**Read [`AGENTS.md`](AGENTS.md) first.** It is the operating model for this repository and
applies to every agent, Claude Code included. Everything below is only what is specific to
Claude Code.

## the-loop is installed as a plugin here

[`.claude/settings.json`](.claude/settings.json) registers
[the-loop](https://github.com/MadaraUchiha-314/the-loop) as a marketplace and enables the
`the-loop@the-loop` plugin, so a session here gets:

- the **`the-loop` skill** — the operating model, loaded on demand;
- the **`/the-loop:*` commands** — `work-on`, `new-requirement`, `create-ticket`,
  `do-task`, `verify-work`, `review-pr`, `work-status`, `init`, `upgrade-the-loop`, …;
- the plugin's **SessionStart hook**, which notices
  [`.the-loop/harness-config.yaml`](.the-loop/harness-config.yaml) and states the
  operating rules at the top of every session;
- the plugin's **Stop hook**, which asks the-loop whether the current graph node is
  complete and blocks the stop when it is not.

If the commands or the skill are missing, the plugin did not install — run
`/plugin` and check the `the-loop` marketplace before working around it by hand.

`${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin's root. The templates
(`skills/the-loop/templates/`) and the config schemas (`.the-loop/*.schema.json`) are read
from **there**, never from this repository — this repo's `.the-loop/` holds configuration
only. Resolving `manifest.schemasDir` against this repository finds a directory that
exists and lacks every file you came for.

## Permissions

The `permissions.allow` list in [`.claude/settings.json`](.claude/settings.json) is the
pre-approved tool surface. If you find yourself repeatedly prompted for a command the loop
genuinely needs, add it there in the same pull request rather than asking for a bypass.

**Prime directive: run the loop.**
