# Capability: Skills, agent plugins and hooks

> Extend the harness with the skill and plugin packages other harnesses accept.

## What it is

Operators add capabilities without writing a yaah plugin: a directory of [Agent Skills](https://agentskills.io), or an [Agent Plugins](https://agent-plugins.org) 1.0.0 package bundling skills and MCP servers. yaah adds hooks and prompt commands to a plugin through a client-extension directory. yaah has no shell: scripts in a skill are never executed, and a hook is an MCP tool.

## Current behaviour

- WHEN a directory in `skills.paths` holds `<name>/SKILL.md` that satisfies the specification THEN the system SHALL register the skill and show the model its name and description only; the body is returned by `load_skill` and a file under the skill by `read_skill_file`.
- IF a skill or plugin fails validation THEN the system SHALL refuse it, name the violated rule, and continue to load the others.
- IF a skill, or a path given to `read_skill_file`, resolves outside its root after following symbolic links THEN the system SHALL refuse it. `read_skill_file` returns UTF-8 text of at most 256 KiB.
- WHEN a plugin is configured (`[[plugins]] path`) or loaded in code THEN the system SHALL validate `plugin.json` and `mcp.json` against the vendored schemas, register its skills and its MCP servers, and expand only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`.
- The system SHALL offer the lifecycle points `message.received`, `llm.before`, `llm.after`, `tool.before`, `tool.after`, `agent.before` and `task.transition`. At `message.received`, `tool.before` and `agent.before` hooks run in registration order and the first `deny` blocks; a hook that throws, times out or answers anything but a decision denies.
- WHEN a hook denies a tool call THEN the system SHALL NOT run the tool and SHALL tell the model it was denied and why.
- WHEN a plugin holds `io.github.madarauchiha-314.yaah/hooks.json` THEN each entry SHALL bind an MCP tool of the plugin's own servers to a lifecycle point; IF that file is invalid THEN the whole plugin SHALL be refused. `commands/<name>.md` in the same directory registers a prompt command.

## Design

- [design.md — Skills, agent plugins and hooks](../specs/issue-3/design.md#skills-agent-plugins-and-hooks)
- Vendored schemas: [`specs/vendor/agent-plugins/`](../../specs/vendor/agent-plugins/); hooks schema: [`specs/plugins/`](../../specs/plugins/)
- `src/kernel/paths.ts` — the containment check

## History

| Work item | What changed | Links                                                                           |
| --------- | ------------ | ------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-011](../decisions/decision-011.md), PR #13 |
