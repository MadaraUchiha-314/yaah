# Integration scenarios (T2)

Run on 2026-11-14 at commit `b3deea5` (branch `issue-3-8-extensibility`), Bun 1.4.0, Node 26.7.0, Linux x64.

`bun run test:integration` — a real harness on a loopback port, driven through the A2A
SDK client with a scripted model, a stub MCP server and a second harness as a remote
agent.

```text
 194 pass
 0 fail
 1014 expect() calls
Ran 194 tests across 38 files. [30.83s]
```

## Scenarios

`the-loop scenarios --root . --glob 'test/**/*.ts' --format markdown` — every Gherkin
docstring in the test tree (integration, contract, security, chaos, live, e2e).

| # | Feature | Scenario | Requirement | Location |
|---|---|---|---|---|
| 1 | Durable execution | A crashed run resumes without repeating a recorded step | docs/specs/issue-3/requirements.md R15.6, R17.3, R17.5 | test/chaos/crash.test.ts:212 |
| 2 | Durable execution | A tool that is safe to retry is run again after a crash | docs/specs/issue-3/requirements.md R17.3, R17.4 | test/chaos/crash.test.ts:230 |
| 3 | CLI, SDK and configuration | The package's export list is a reviewed contract | docs/specs/issue-3/requirements.md R22.6, R26.7 | test/contract/api.test.ts:10 |
| 4 | Browser build | The browser build completes a multi-turn task without a server | docs/specs/issue-3/requirements.md R25.1, R25.2 | test/e2e/browser-build.spec.ts:138 |
| 5 | Browser build | A credential given to the page reaches the model it is configured for | docs/specs/issue-3/requirements.md R25.2 | test/e2e/browser-build.spec.ts:202 |
| 6 | Browser build | A page with no usable model says why | docs/specs/issue-3/requirements.md R25.2 | test/e2e/browser-build.spec.ts:227 |
| 7 | Terminal UI | A whole conversation on a real terminal | docs/specs/issue-3/requirements.md R21.1, R21.3, R19.4, R14.2–14.4, R23.2 | test/e2e/tui.spec.ts:21 |
| 8 | Web renderer | Every state passes an automated accessibility check | docs/specs/issue-3/requirements.md R20.6 | test/e2e/web-a11y.spec.ts:25 |
| 9 | Web renderer | The whole flow works with the keyboard alone | docs/specs/issue-3/requirements.md R20.6 | test/e2e/web-a11y.spec.ts:55 |
| 10 | Web renderer | The attach, microphone and spoken-answers controls are reachable by keyboard | docs/specs/issue-3/requirements.md R20.6, R24.4, R24.5 | test/e2e/web-a11y.spec.ts:108 |
| 11 | Web renderer | The page fits a 400 px wide window | docs/specs/issue-3/requirements.md R20.1 | test/e2e/web-a11y.spec.ts:134 |
| 12 | Web renderer | An attached image is shown before sending and reaches the model | docs/specs/issue-3/requirements.md R24.1 | test/e2e/web-media.spec.ts:12 |
| 13 | Web renderer | An image pasted into the input is attached, and can be removed | docs/specs/issue-3/requirements.md R24.1 | test/e2e/web-media.spec.ts:43 |
| 14 | Web renderer | An attachment over the server's limit is refused with the server's reason | docs/specs/issue-3/requirements.md R24.1, R26.4 | test/e2e/web-media.spec.ts:70 |
| 15 | Web renderer | An image the agent makes is drawn in the conversation | docs/specs/issue-3/requirements.md R24.2 | test/e2e/web-media.spec.ts:93 |
| 16 | Web renderer | A denied microphone is said in words and text input still works | docs/specs/issue-3/requirements.md R24.6 | test/e2e/web-voice-denied.spec.ts:18 |
| 17 | Web renderer | A browser that cannot capture audio says so and text input still works | docs/specs/issue-3/requirements.md R24.6 | test/e2e/web-voice-unavailable.spec.ts:8 |
| 18 | Web renderer | A browser without a microphone API says so and text input still works | docs/specs/issue-3/requirements.md R24.6 | test/e2e/web-voice-unavailable.spec.ts:27 |
| 19 | Web renderer | The microphone button records a voice message and submits it as the turn | docs/specs/issue-3/requirements.md R24.4 | test/e2e/web-voice.spec.ts:24 |
| 20 | Web renderer | With voice output on, the answer is played while it is still being written | docs/specs/issue-3/requirements.md R24.5 | test/e2e/web-voice.spec.ts:55 |
| 21 | Web renderer | The web UI streams an answer and shows the task state | docs/specs/issue-3/requirements.md R20.2, R20.3 | test/e2e/web.spec.ts:12 |
| 22 | Web renderer | The agent asks for input and the request is visually distinct | docs/specs/issue-3/requirements.md R20.4, R14.5 | test/e2e/web.spec.ts:51 |
| 23 | Web renderer | Complete and Cancel end the task | docs/specs/issue-3/requirements.md R20.3, R14.3 | test/e2e/web.spec.ts:82 |
| 24 | Web renderer | A matched command is highlighted and never reaches the model | docs/specs/issue-3/requirements.md R20.5, R23.1 | test/e2e/web.spec.ts:111 |
| 25 | Surfaces and renderers | A basic-catalog A2UI form is drawn and its button sends an action | docs/specs/issue-3/requirements.md R19.4, R19.6 | test/e2e/web.spec.ts:161 |
| 26 | Surfaces and renderers | A hostile A2UI surface falls back to text | docs/specs/issue-3/requirements.md R19.5; abuse case 5 | test/e2e/web.spec.ts:192 |
| 27 | Web renderer | Tool calls are grouped, and a failed one says so | docs/specs/issue-3/requirements.md R20.1, R8.5 | test/e2e/web.spec.ts:221 |
| 28 | Task lifecycle | A response completes a task by default | docs/specs/issue-3/requirements.md R13.1, R14.1, R19.2 | test/integration/a2a-lifecycle.test.ts:26 |
| 29 | Task lifecycle | A long-running task stays open across turns | docs/specs/issue-3/requirements.md R14.2, R14.3, R14.4 | test/integration/a2a-lifecycle.test.ts:47 |
| 30 | Task lifecycle | A client completes an open task | docs/specs/issue-3/requirements.md R14.6 | test/integration/a2a-lifecycle.test.ts:77 |
| 31 | Task lifecycle | A client cancels an idle open task | docs/specs/issue-3/requirements.md R14.6 | test/integration/a2a-lifecycle.test.ts:95 |
| 32 | Task lifecycle | A message to a completed task is rejected | docs/specs/issue-3/requirements.md R14.7 | test/integration/a2a-lifecycle.test.ts:115 |
| 33 | Task lifecycle | The agent asks for input and continues on the reply | docs/specs/issue-3/requirements.md R14.5 | test/integration/a2a-lifecycle.test.ts:136 |
| 34 | A2A API server | Every A2A operation answers over JSON-RPC and HTTP+JSON | docs/specs/issue-3/requirements.md R13.1 | test/integration/a2a-server.test.ts:120 |
| 35 | A2A API server | The agent card lists every yaah extension | docs/specs/issue-3/requirements.md R13.2, R13.3 | test/integration/a2a-server.test.ts:139 |
| 36 | A2A API server | A required unsupported extension is rejected | docs/specs/issue-3/requirements.md R13.4 | test/integration/a2a-server.test.ts:169 |
| 37 | A2A API server | A malformed request creates no task | docs/specs/issue-3/requirements.md R13.5 | test/integration/a2a-server.test.ts:211 |
| 38 | Surfaces and renderers | The agent answers with a basic-catalog A2UI surface | docs/specs/issue-3/requirements.md R19.4, R19.6 | test/integration/a2ui.test.ts:37 |
| 39 | Surfaces and renderers | A client that does not offer A2UI gets text only | docs/specs/issue-3/requirements.md R19.5 | test/integration/a2ui.test.ts:72 |
| 40 | Security | A2UI that names a component outside the catalog is dropped | docs/specs/issue-3/requirements.md abuse case 5 | test/integration/a2ui.test.ts:88 |
| 41 | Surfaces and renderers | A user's action on an A2UI surface reaches the model | docs/specs/issue-3/requirements.md R19.4 | test/integration/a2ui.test.ts:118 |
| 42 | A2A API server | The agent card advertises A2UI | docs/specs/issue-3/requirements.md R13.3, R19.6 | test/integration/a2ui.test.ts:166 |
| 43 | Durable execution | Unreachable remote Temporal stops start-up | docs/specs/issue-3/requirements.md R17.7, R1.4 | test/integration/app-plugins.test.ts:18 |
| 44 | A2A API server | A plugin adds to the agent card and can take it back | docs/specs/issue-3/requirements.md R13.3, R1.5 | test/integration/app-plugins.test.ts:47 |
| 45 | Context window manager and compaction | Compaction is reported as an event | docs/specs/issue-3/requirements.md R6.5 | test/integration/app-plugins.test.ts:84 |
| 46 | Observability | A run that ends with an unrecordable error is reported as an event | docs/specs/issue-3/requirements.md R18.1 | test/integration/app-plugins.test.ts:117 |
| 47 | Tools and MCP | MCP tools from the configuration are usable with no code | docs/specs/issue-3/requirements.md R1.1, R8.1 | test/integration/app-plugins.test.ts:162 |
| 48 | Surfaces and renderers | A second surface takes up an open task and both stay in step | docs/specs/issue-3/requirements.md R19.1, R19.3, R27.1, R27.4 | test/integration/attach.test.ts:68 |
| 49 | Surfaces and renderers | A surface does not take up another's task unless asked to | docs/specs/issue-3/requirements.md R19.3 | test/integration/attach.test.ts:112 |
| 50 | Browser build | A build that includes a node-only plugin fails by name | docs/specs/issue-3/requirements.md R25.3 | test/integration/browser-build.test.ts:25 |
| 51 | Browser build | A plugin that needs Node without saying so still fails the build by name | docs/specs/issue-3/requirements.md R25.3 | test/integration/browser-build.test.ts:41 |
| 52 | Browser build | A surface sees a turn as a growing transcript, whatever the transport | docs/specs/issue-3/requirements.md R25.1, R25.2, R19.2 | test/integration/browser-harness.test.ts:87 |
| 53 | Browser build | A multi-turn task is asked for input, completed and cancelled, whatever the transport | docs/specs/issue-3/requirements.md R25.2, R14.3, R14.5, R14.6 | test/integration/browser-harness.test.ts:117 |
| 54 | Browser build | Commands and a second surface work, whatever the transport | docs/specs/issue-3/requirements.md R25.2, R19.3, R23.1 | test/integration/browser-harness.test.ts:152 |
| 55 | Browser build | The harness calls itself as a sub-agent, whatever the transport | docs/specs/issue-3/requirements.md R25.1, R11.4 | test/integration/browser-harness.test.ts:197 |
| 56 | Browser build | The in-memory target is the SDK client on the harness's own request handler | docs/specs/issue-3/requirements.md R25.1, R25.2 | test/integration/browser-harness.test.ts:227 |
| 57 | Participants and channels | A message from a non-participant is rejected | docs/specs/issue-3/requirements.md R12.3, R12.5 | test/integration/channels.test.ts:99 |
| 58 | Participants and channels | A quick question to a participant returns their reply | docs/specs/issue-3/requirements.md R12.2, R12.3, R14.5 | test/integration/channels.test.ts:142 |
| 59 | Participants and channels | A task is created for a participant | docs/specs/issue-3/requirements.md R12.2, R12.3, R4.5 | test/integration/channels.test.ts:183 |
| 60 | Participants and channels | Only the harness changes a channel's participants | docs/specs/issue-3/requirements.md R12.4, R12.5 | test/integration/channels.test.ts:238 |
| 61 | Participants and channels | The model is shown the participants and what each role means | docs/specs/issue-3/requirements.md R12.1, R12.2, R10.2 | test/integration/channels.test.ts:279 |
| 62 | CLI | `yaah` starts a harness and opens the terminal UI against it | docs/specs/issue-3/requirements.md R22.1, R22.4, R18.3 | test/integration/cli.test.ts:85 |
| 63 | CLI | The first run creates the configuration file | docs/specs/issue-3/requirements.md R22.3, R22.7 | test/integration/cli.test.ts:113 |
| 64 | CLI | `yaah serve` serves until interrupted | docs/specs/issue-3/requirements.md R22.2 | test/integration/cli.test.ts:134 |
| 65 | CLI | An invalid configuration stops the command and names what is wrong | docs/specs/issue-3/requirements.md R22.5 | test/integration/cli.test.ts:164 |
| 66 | CLI | `yaah tui --url` opens the terminal UI against a running harness | docs/specs/issue-3/requirements.md R21.3 | test/integration/cli.test.ts:185 |
| 67 | Commands | A command never reaches the model | docs/specs/issue-3/requirements.md R23.1, R23.2, R7.3 | test/integration/commands.test.ts:30 |
| 68 | Commands | A command on an open task changes that task | docs/specs/issue-3/requirements.md R23.2 | test/integration/commands.test.ts:58 |
| 69 | Commands | An unknown command is reported | docs/specs/issue-3/requirements.md R23.5 | test/integration/commands.test.ts:77 |
| 70 | Commands | A plugin registers a command as a name and a function | docs/specs/issue-3/requirements.md R23.3, R23.4 | test/integration/commands.test.ts:94 |
| 71 | Commands | The built-in commands validate what they are given | docs/specs/issue-3/requirements.md R23.2 | test/integration/commands.test.ts:137 |
| 72 | Context window manager and compaction | An oversized conversation is compacted before the model call | docs/specs/issue-3/requirements.md R6.3, R6.4, R6.5 | test/integration/compaction.test.ts:12 |
| 73 | Context window manager and compaction | A small conversation is left alone | docs/specs/issue-3/requirements.md R6.3 | test/integration/compaction.test.ts:80 |
| 74 | Plugin kernel and composition | A root composition includes a shared file | docs/specs/issue-3/requirements.md R1.1, R1.2 | test/integration/composition.test.ts:26 |
| 75 | Plugin kernel and composition | A composition replaces a default plugin by id | docs/specs/issue-3/requirements.md R1.3 | test/integration/composition.test.ts:40 |
| 76 | Plugin kernel and composition | An override changes only the configuration of a default plugin | docs/specs/issue-3/requirements.md R1.3 | test/integration/composition.test.ts:57 |
| 77 | Plugin kernel and composition | A plugin that fails to load stops start-up and is named | docs/specs/issue-3/requirements.md R1.4 | test/integration/composition.test.ts:74 |
| 78 | Plugin kernel and composition | A plugin that cannot be found stops start-up and is named | docs/specs/issue-3/requirements.md R1.4 | test/integration/composition.test.ts:92 |
| 79 | Plugin kernel and composition | Disposing a plugin removes what it registered | docs/specs/issue-3/requirements.md R1.5 | test/integration/composition.test.ts:108 |
| 80 | Inbox and events | A message for a working task gets a well-formed stream of its own | docs/specs/issue-3/requirements.md R15.4, R13.1 | test/integration/concurrent-streams.test.ts:21 |
| 81 | Task lifecycle | A response completes a task by default | docs/specs/issue-3/requirements.md R3.2, R14.1 | test/integration/core-loop.test.ts:22 |
| 82 | Core loop | Parallel tool calls return in order | docs/specs/issue-3/requirements.md R3.3 | test/integration/core-loop.test.ts:40 |
| 83 | Core loop | One failed tool call does not lose the others | docs/specs/issue-3/requirements.md R3.4, R8.5 | test/integration/core-loop.test.ts:79 |
| 84 | Security | An unregistered tool is refused and reported to the model | docs/specs/issue-3/requirements.md abuse case 3 | test/integration/core-loop.test.ts:110 |
| 85 | Core loop | The iteration limit fails the task | docs/specs/issue-3/requirements.md R3.6, abuse case 9 | test/integration/core-loop.test.ts:127 |
| 86 | Security | The task token budget fails the task before the next model call | docs/specs/issue-3/requirements.md abuse case 9 | test/integration/core-loop.test.ts:148 |
| 87 | Core loop | Cancel stops a working task | docs/specs/issue-3/requirements.md R3.5 | test/integration/core-loop.test.ts:171 |
| 88 | A2A API server | A message that says nothing is refused before any model call | docs/specs/issue-3/requirements.md R13.1; Security considerations, | test/integration/exploratory-findings.test.ts:32 |
| 89 | Commands | After a command's reply the view is in the state it was in before | docs/specs/issue-3/requirements.md R23.1, R20.2 | test/integration/exploratory-findings.test.ts:60 |
| 90 | Heartbeat | The heartbeat reports a stalled task | docs/specs/issue-3/requirements.md R16.1, R16.2, R16.3 | test/integration/heartbeat.test.ts:54 |
| 91 | Heartbeat | The heartbeat hands an untaken inbox item to its task again | docs/specs/issue-3/requirements.md R16.2, R15.6 | test/integration/heartbeat.test.ts:96 |
| 92 | Skills, agent plugins and hooks | A programmatic hook denies a tool call | docs/specs/issue-3/requirements.md R9.3 | test/integration/hooks.test.ts:44 |
| 93 | Skills, agent plugins and hooks | A hook that throws denies, and is logged | docs/specs/issue-3/requirements.md R9.3 | test/integration/hooks.test.ts:108 |
| 94 | Skills, agent plugins and hooks | Every lifecycle point reaches its hooks, in order | docs/specs/issue-3/requirements.md R9.3 | test/integration/hooks.test.ts:146 |
| 95 | Skills, agent plugins and hooks | A hook refuses a message | docs/specs/issue-3/requirements.md R9.3 | test/integration/hooks.test.ts:199 |
| 96 | Skills, agent plugins and hooks | A hook refuses a sub-agent | docs/specs/issue-3/requirements.md R9.3 | test/integration/hooks.test.ts:239 |
| 97 | Inbox and events | A sub-task status event is accepted as inbox input | docs/specs/issue-3/requirements.md R15.3, R15.4 | test/integration/inbox-events.test.ts:78 |
| 98 | Security | A forged inbox event is discarded | docs/specs/issue-3/requirements.md abuse case 10 | test/integration/inbox-events.test.ts:97 |
| 99 | Inbox and events | With triage on, an unmarked message for a working task is classified | docs/specs/issue-3/requirements.md R7.5, R7.6 | test/integration/inbox-triage.test.ts:125 |
| 100 | Inbox and events | With triage on, an unmarked message for a working task is classified | docs/specs/issue-3/requirements.md R7.5, R7.6, R15.5 | test/integration/inbox-triage.test.ts:150 |
| 101 | Inbox and events | A marked message is not classified | docs/specs/issue-3/requirements.md R7.6, R15.5 | test/integration/inbox-triage.test.ts:171 |
| 102 | Inbox and events | With triage off System One is never called | docs/specs/issue-3/requirements.md R7.6 | test/integration/inbox-triage.test.ts:194 |
| 103 | Inbox and events | A System One failure does not interrupt | docs/specs/issue-3/requirements.md R7.6 | test/integration/inbox-triage.test.ts:212 |
| 104 | Observability | With Langfuse configured, spans are exported to its OTLP endpoint | docs/specs/issue-3/requirements.md R18.4, R18.5 | test/integration/langfuse.test.ts:72 |
| 105 | Observability | A missing Langfuse key stops start-up | docs/specs/issue-3/requirements.md R18.5 | test/integration/langfuse.test.ts:111 |
| 106 | Tools and MCP | MCP tools are registered from a configured server | docs/specs/issue-3/requirements.md R8.1 | test/integration/mcp.test.ts:133 |
| 107 | Tools and MCP | A non-idempotent MCP tool runs once per call | docs/specs/issue-3/requirements.md R8.1 | test/integration/mcp.test.ts:186 |
| 108 | Tools and MCP | An unreachable MCP server does not stop start-up | docs/specs/issue-3/requirements.md R8.4 | test/integration/mcp.test.ts:213 |
| 109 | Tools and MCP | MCP tools are served over Streamable HTTP | docs/specs/issue-3/requirements.md R8.1, R8.5 | test/integration/mcp.test.ts:253 |
| 110 | Tools and MCP | A failing MCP tool is reported to the model and the task continues | docs/specs/issue-3/requirements.md R8.5 | test/integration/mcp.test.ts:308 |
| 111 | Tools and MCP | A tool the MCP server does not offer is refused | docs/specs/issue-3/requirements.md abuse case 3 | test/integration/mcp.test.ts:334 |
| 112 | Tools and MCP | A stdio MCP server sees only the environment it was given | docs/specs/issue-3/requirements.md R8.1 (design: least privilege) | test/integration/mcp.test.ts:354 |
| 113 | Multi-modal input | An image turn reaches a model that accepts images | docs/specs/issue-3/requirements.md R24.1 | test/integration/modalities.test.ts:48 |
| 114 | Multi-modal input | A turn with an unsupported modality is answered without a model call | docs/specs/issue-3/requirements.md R24.1 | test/integration/modalities.test.ts:81 |
| 115 | Multi-modal input | A linked image is never fetched by the harness | docs/specs/issue-3/requirements.md R24.1; abuse case 7 | test/integration/modalities.test.ts:104 |
| 116 | Multi-modal input | A part over the size limit is refused before a task exists | docs/specs/issue-3/requirements.md R24.1, R26.4 | test/integration/modalities.test.ts:137 |
| 117 | Image output | An image the agent generates is delivered as an artifact | docs/specs/issue-3/requirements.md R24.2 | test/integration/modalities.test.ts:164 |
| 118 | Observability | Every step of a task is logged with task and trace ids | docs/specs/issue-3/requirements.md R18.1, R18.3 | test/integration/observability.test.ts:60 |
| 119 | Observability | One trace spans the A2A call, the model call and the tool call | docs/specs/issue-3/requirements.md R18.2 | test/integration/observability.test.ts:113 |
| 120 | Observability | A caller's trace is continued | docs/specs/issue-3/requirements.md R18.2 | test/integration/observability.test.ts:164 |
| 121 | Observability | A failing step is logged as an error and its span is marked failed | docs/specs/issue-3/requirements.md R18.1, R23.4 | test/integration/observability.test.ts:191 |
| 122 | Skills, agent plugins and hooks | An agent plugin registers its skills and MCP servers | docs/specs/issue-3/requirements.md R9.2 | test/integration/plugins.test.ts:73 |
| 123 | Skills, agent plugins and hooks | A hook denies a tool call | docs/specs/issue-3/requirements.md R9.3 | test/integration/plugins.test.ts:138 |
| 124 | Skills, agent plugins and hooks | A policy that cannot be asked denies | docs/specs/issue-3/requirements.md R9.3 | test/integration/plugins.test.ts:211 |
| 125 | Skills, agent plugins and hooks | A prompt command sends its text to the model | docs/specs/issue-3/requirements.md R9.2 | test/integration/plugins.test.ts:265 |
| 126 | Skills, agent plugins and hooks | A plugin that breaks the specification is refused and named | docs/specs/issue-3/requirements.md R9.4 | test/integration/plugins.test.ts:313 |
| 127 | Skills, agent plugins and hooks | A plugin is loaded from code | docs/specs/issue-3/requirements.md R9.2, R9.4 | test/integration/plugins.test.ts:380 |
| 128 | Skills, agent plugins and hooks | A plugin cannot reach outside its root | docs/specs/issue-3/requirements.md Security considerations, abuse case 11 | test/integration/plugins.test.ts:480 |
| 129 | Durable execution | A restarted run resumes without repeating a recorded step | docs/specs/issue-3/requirements.md R5.4, R17.3 | test/integration/replay.test.ts:17 |
| 130 | Durable execution | An item the first run already read is not consumed twice after a restart | docs/specs/issue-3/requirements.md R15.6 | test/integration/replay.test.ts:79 |
| 131 | Durable execution | An interrupted iteration replays as interrupted | docs/specs/issue-3/requirements.md R15.5, R17.3 | test/integration/replay.test.ts:107 |
| 132 | State and persistence | State and plan are restored after a restart | docs/specs/issue-3/requirements.md R5.3, R5.4, R17.3 | test/integration/restart.test.ts:41 |
| 133 | Inbox and events | An inbox item survives a restart | docs/specs/issue-3/requirements.md R15.2, R15.6 | test/integration/restart.test.ts:83 |
| 134 | Surfaces and renderers | A surface sees a turn as a growing transcript | docs/specs/issue-3/requirements.md R19.1, R19.2, R20.2, R20.3 | test/integration/session.test.ts:45 |
| 135 | Task lifecycle | A surface continues, is asked for input, completes and cancels | docs/specs/issue-3/requirements.md R14.3, R14.5, R14.6, R20.4 | test/integration/session.test.ts:78 |
| 136 | Commands | A surface knows the commands and shows a command's reply as a note | docs/specs/issue-3/requirements.md R20.5, R23.1 | test/integration/session.test.ts:118 |
| 137 | Surfaces and renderers | Two surfaces follow one task | docs/specs/issue-3/requirements.md R19.3 | test/integration/session.test.ts:140 |
| 138 | Surfaces and renderers | A surface that renders A2UI receives the surface and returns an action | docs/specs/issue-3/requirements.md R19.4 | test/integration/session.test.ts:190 |
| 139 | Skills | A skill body is loaded only when used | docs/specs/issue-3/requirements.md R9.1 | test/integration/skills.test.ts:45 |
| 140 | Skills | A skill that breaks the specification is refused and named | docs/specs/issue-3/requirements.md R9.4 | test/integration/skills.test.ts:101 |
| 141 | Skills | Without skills the context has no skills section | docs/specs/issue-3/requirements.md R9.1 | test/integration/skills.test.ts:154 |
| 142 | Security | A card may only point at its own host or an allowed one | docs/specs/issue-3/requirements.md abuse case 7 | test/integration/sub-agents-unavailable.test.ts:53 |
| 143 | Sub-agents over A2A | An unreachable agent does not stop start-up and is registered when it appears | docs/specs/issue-3/requirements.md R11.1 | test/integration/sub-agents-unavailable.test.ts:80 |
| 144 | Sub-agents over A2A | A sub-agent call links a sub-task | docs/specs/issue-3/requirements.md R4.5, R4.6, R11.1, R11.2, R11.3, R11.5 | test/integration/sub-agents.test.ts:66 |
| 145 | Sub-agents over A2A | A loopback sub-agent gets a fresh context | docs/specs/issue-3/requirements.md R11.4, R11.5 | test/integration/sub-agents.test.ts:103 |
| 146 | Task lifecycle | A sub-task ignores the long-running request | docs/specs/issue-3/requirements.md R14.8 | test/integration/sub-agents.test.ts:131 |
| 147 | Sub-agents over A2A | A failed sub-task is reported to the model | docs/specs/issue-3/requirements.md R11.6 | test/integration/sub-agents.test.ts:155 |
| 148 | Sub-agents over A2A | A sub-agent that needs input says so, and can be answered | docs/specs/issue-3/requirements.md R11.6, R14.5 | test/integration/sub-agents.test.ts:176 |
| 149 | Security | Delegation past the depth limit is refused | docs/specs/issue-3/requirements.md R11.7, abuse case 9 | test/integration/sub-agents.test.ts:210 |
| 150 | Security | An agent the operator did not declare cannot be called | docs/specs/issue-3/requirements.md abuse case 3, abuse case 7 | test/integration/sub-agents.test.ts:244 |
| 151 | Sub-agents over A2A | An agent entity offers the three operations of the agent interface | docs/specs/issue-3/requirements.md R3.1 | test/integration/sub-agents.test.ts:285 |
| 152 | Task lifecycle | A long-running task stays open across turns | docs/specs/issue-3/requirements.md R14.2, R14.3 | test/integration/task-lifecycle.test.ts:34 |
| 153 | Task lifecycle | A client completes an open task | docs/specs/issue-3/requirements.md R14.6 | test/integration/task-lifecycle.test.ts:69 |
| 154 | Task lifecycle | A client cancels an idle open task | docs/specs/issue-3/requirements.md R14.6, R3.5 | test/integration/task-lifecycle.test.ts:86 |
| 155 | Task lifecycle | The agent asks for input and continues on the reply | docs/specs/issue-3/requirements.md R14.5 | test/integration/task-lifecycle.test.ts:103 |
| 156 | Task lifecycle | A second question in the same reply is refused | docs/specs/issue-3/requirements.md R14.5 | test/integration/task-lifecycle.test.ts:148 |
| 157 | Inbox and events | A message during tool execution is read at the next iteration | docs/specs/issue-3/requirements.md R15.5 | test/integration/task-lifecycle.test.ts:176 |
| 158 | Inbox and events | A message that arrives as the model finishes is not skipped | docs/specs/issue-3/requirements.md R15.5 | test/integration/task-lifecycle.test.ts:209 |
| 159 | Inbox and events | An interrupting item aborts the current iteration | docs/specs/issue-3/requirements.md R15.5 | test/integration/task-lifecycle.test.ts:231 |
| 160 | Inbox and events | A redelivered item is consumed once | docs/specs/issue-3/requirements.md R15.6 | test/integration/task-lifecycle.test.ts:262 |
| 161 | Durable execution | The Temporal Web UI address is printed and in the agent card | docs/specs/issue-3/requirements.md R17.8 | test/integration/temporal.test.ts:62 |
| 162 | Durable execution | Embedded mode serves the Temporal Web UI | docs/specs/issue-3/requirements.md R17.9 | test/integration/temporal.test.ts:81 |
| 163 | Durable execution | A long-running task runs as a workflow and carries a link to it | docs/specs/issue-3/requirements.md R17.2, R17.6, R17.10, R14.2, R14.6 | test/integration/temporal.test.ts:109 |
| 164 | Durable execution | Asking for input, parallel tools and cancel behave the same on Temporal | docs/specs/issue-3/requirements.md R17.6, R14.5, R3.3, R14.6 | test/integration/temporal.test.ts:143 |
| 165 | TUI renderer | The terminal UI streams an answer and shows the task state | docs/specs/issue-3/requirements.md R21.1 (R20.2, R20.3) | test/integration/tui.test.ts:94 |
| 166 | TUI renderer | The terminal UI asks for input and continues on the reply | docs/specs/issue-3/requirements.md R21.1 (R20.4) | test/integration/tui.test.ts:134 |
| 167 | TUI renderer | Ctrl+D completes and Ctrl+X cancels the task | docs/specs/issue-3/requirements.md R21.1 (R20.3) | test/integration/tui.test.ts:164 |
| 168 | TUI renderer | A matched command is highlighted and never reaches the model | docs/specs/issue-3/requirements.md R21.1 (R20.5) | test/integration/tui.test.ts:204 |
| 169 | TUI renderer | A basic-catalog A2UI form is drawn and its button sends an action | docs/specs/issue-3/requirements.md R19.4 | test/integration/tui.test.ts:239 |
| 170 | Security | Terminal escape sequences in a reply are neutralised | docs/specs/issue-3/requirements.md abuse case 6 | test/integration/tui.test.ts:282 |
| 171 | TUI renderer | Without a TTY the interface prints plain lines | docs/specs/issue-3/requirements.md R21.2 | test/integration/tui.test.ts:309 |
| 172 | TUI renderer | Leaving the terminal UI restores the terminal | docs/specs/issue-3/requirements.md R21.3 | test/integration/tui.test.ts:360 |
| 173 | Voice | An audio turn is transcribed for a text-only model | docs/specs/issue-3/requirements.md R24.1, R24.3, R24.4 | test/integration/voice.test.ts:64 |
| 174 | Voice | Spoken output streams audio chunks before the final event | docs/specs/issue-3/requirements.md R24.5 | test/integration/voice.test.ts:96 |
| 175 | Voice | Nothing is spoken unless the turn asks for it and a voice is configured | docs/specs/issue-3/requirements.md R24.5 | test/integration/voice.test.ts:155 |
| 176 | Voice | A voice that fails does not fail the answer | docs/specs/issue-3/requirements.md R24.5 | test/integration/voice.test.ts:187 |
| 177 | Voice | The agent card declares the voice extension and a surface uses it | docs/specs/issue-3/requirements.md R24.3–24.5, R13.3 | test/integration/voice.test.ts:213 |
| 178 | Web renderer | The harness serves the web chat from its own origin | docs/specs/issue-3/requirements.md R20.1 | test/integration/web-ui.test.ts:38 |
| 179 | Web renderer | Without a built application nothing is served | docs/specs/issue-3/requirements.md R20.1 | test/integration/web-ui.test.ts:77 |
| 180 | Web renderer | A disposed web UI plugin stops answering | docs/specs/issue-3/requirements.md R1.5 | test/integration/web-ui.test.ts:100 |
| 181 | Surfaces and renderers | The web renderer is an entity that offers the basic catalog | docs/specs/issue-3/requirements.md R19.1, R19.4 | test/integration/web-ui.test.ts:124 |
| 182 | Web renderer | The default location is the built application of the package | docs/specs/issue-3/requirements.md R20.1 | test/integration/web-ui.test.ts:137 |
| 183 | Live providers | A real model is shown an image a user attached and says what it shows | docs/specs/issue-3/requirements.md R24.1, R27.2 | test/live/anthropic-image.test.ts:35 |
| 184 | Live providers | A real model works a long-running task with a tool across two turns | docs/specs/issue-3/requirements.md R6.2, R8.1, R14.1–14.4, R27.2 | test/live/providers.test.ts:53 |
| 185 | Live providers | OpenAI GPT 6.1 works the same task | docs/specs/issue-3/requirements.md R6.1, R7.1, R27.5 | test/live/providers.test.ts:130 |
| 186 | Live providers | The same task runs as a workflow on embedded Temporal | docs/specs/issue-3/requirements.md R17.2, R17.8, R27.4 | test/live/providers.test.ts:146 |
| 187 | Live providers | The same task runs as a workflow on Temporal Cloud | docs/specs/issue-3/requirements.md R17.3, R17.8, R27.4 | test/live/providers.test.ts:172 |
| 188 | CLI, SDK and configuration | The built package runs on Node and answers over A2A | docs/specs/issue-3/requirements.md R22.1, R22.2, R22.6, R6.4 | test/package/built.test.ts:72 |
| 189 | Security | Instructions inside a tool result grant nothing | docs/specs/issue-3/requirements.md Security considerations, abuse case 4 | test/security/abuse-cases.test.ts:26 |
| 190 | Security | A URL in a message is never fetched | docs/specs/issue-3/requirements.md Security considerations, abuse case 7 | test/security/abuse-cases.test.ts:60 |
| 191 | Security | A credential that surfaces in an error or a tool result leaves by no exit | docs/specs/issue-3/requirements.md R18.4; Security considerations, | test/security/credential-leak.test.ts:29 |
| 192 | Security | The harness listens on loopback unless told otherwise | docs/specs/issue-3/requirements.md abuse case 1 | test/security/network.test.ts:52 |
| 193 | Security | A browser request from a foreign origin is rejected | docs/specs/issue-3/requirements.md abuse case 2 | test/security/network.test.ts:66 |
| 194 | Security | The harness's own origin and an allowed origin may call | docs/specs/issue-3/requirements.md abuse case 2 | test/security/network.test.ts:88 |
| 195 | Security | An oversized or flooding request is rejected before any model call | docs/specs/issue-3/requirements.md abuse case 8 | test/security/network.test.ts:113 |
| 196 | Security | A skill symlinked from outside its configured root is not registered | docs/specs/issue-3/requirements.md Security considerations, abuse case 11 | test/security/skill-paths.test.ts:57 |
| 197 | Security | read_skill_file cannot leave the skill's directory | docs/specs/issue-3/requirements.md Security considerations, abuse case 11 | test/security/skill-paths.test.ts:97 |
| 198 | Security | A refused path reaches the model as a tool result and the task continues | docs/specs/issue-3/requirements.md Security considerations, abuse case 11 | test/security/skill-paths.test.ts:144 |
