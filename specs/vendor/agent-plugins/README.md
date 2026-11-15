# Agent Plugins schemas (vendored)

The JSON Schemas of the [Agent Plugins specification](https://agent-plugins.org), copied
unchanged. yaah validates `plugin.json` and `mcp.json` against these copies: the
specification forbids retrieving a schema while a plugin is loaded (§5.2, §7.2.1).

|                       |                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Specification version | 1.0.0                                                                                                                    |
| Source                | https://github.com/agentplugins/agent-plugins-spec, `schemas/1.0.0/`                                                     |
| Commit                | `6395e8906b30e2f333b792bfaa981d790993d56f`                                                                               |
| Canonical identifiers | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` |
| Copied on             | 2026-11-14                                                                                                               |
| License               | Apache-2.0 (schemas; see the source repository's `LICENSE.md`)                                                           |

Do not edit these files. A new specification version is a new directory beside `1.0.0/`
and a change to `src/harness/plugins/` to recognise it.
