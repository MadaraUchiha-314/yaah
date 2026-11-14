# Capabilities — yaah

The **organized view of the specs**: one living doc per capability, each the single
source of truth for that capability's _current_ behaviour, with history rows tracing
every behaviour back to the raw specs (`docs/specs/<id>/`) and decisions that produced
it. Affected docs are updated **in the same PR** as the work item that changes behaviour.

| Capability                                                                | What it covers                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Tasks and their lifecycle](tasks.md)                                     | A conversation is a task that lives across turns until a client ends it.             |
| [Durable execution](durable-execution.md)                                 | A task survives a restart, in process or on Temporal.                                |
| [Models](models.md)                                                       | Which models the agent can think with, and how one is chosen.                        |
| [Tools, MCP and sub-agents](tools.md)                                     | What the agent can do besides talk: call tools, and hand work to other agents.       |
| [Skills, agent plugins and hooks](extensibility.md)                       | Extend the harness with the skill and plugin packages other harnesses accept.        |
| [Participants and channels](participants-and-channels.md)                 | The harness knows who is on a task and asks the right one the right way.             |
| [Observability](observability.md)                                         | What the harness did, as logs and traces, without leaking a credential.              |
| [Configuration, the `yaah` command and the SDK](configuration-and-cli.md) | One file configures a harness; the command and the library are the same code.        |
| [The A2A API and its limits](api-security.md)                             | How clients reach the harness, and what stands between the network and a model call. |
