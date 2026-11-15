# yaah

**Yet Another Agent Harness** — an opinionated harness for running agents in
customer-facing workflows. It holds a conversation as a long-lived task, calls a model
and tools on the task's behalf, speaks [A2A](https://a2a-protocol.org) to its clients and
to other agents, and survives a restart in the middle of a turn.

It is **not** a coding harness: it has no shell and no file tools.

> **No authentication yet.** The A2A API is open to anyone who can reach its port. It
> binds `127.0.0.1` by default; do not bind another address on a network you do not
> trust. See [decision-012](docs/decisions/decision-012.md).

## Run it

```sh
export ANTHROPIC_API_KEY=…        # or OPENAI_API_KEY
bun install && bun run build

node dist/cli/bin.js              # a harness on loopback + a chat in your terminal
node dist/cli/bin.js serve        # a harness serving the A2A API and the web chat
node dist/cli/bin.js tui --url http://127.0.0.1:7420   # chat with one already running
                                  # add --attach to take up the task open there
```

Installed as a package (`@yaah/yaah`), the command is `yaah`.

| In the chat                  | Does                                                |
| ---------------------------- | --------------------------------------------------- |
| Enter                        | Sends the message                                   |
| `/model [id]`, `/effort [x]` | Shows or selects the model and the reasoning effort |
| Ctrl+D / **Complete task**   | Ends the task as done                               |
| Ctrl+X / **Cancel task**     | Cancels it                                          |
| Ctrl+O / **Temporal ↗**      | Shows the task's workflow, when Temporal is in use  |
| `/exit`, Ctrl+C              | Leaves the terminal chat (the task stays open)      |

Without a terminal (`yaah | cat`, or `NO_COLOR` set) the chat prints plain lines.

## Configure it

The first run writes `~/.yaah/config.toml` with every default, commented, and no secret.
`--config <path>` uses another file. A key ending in `_env` names an environment variable;
credentials are never written to the file.

```toml
[model]
llm = "anthropic/claude-sonnet-5-5" # or openai/gpt-6.1-sol, or <id>/<model> of a compatible endpoint
effort = "medium"

[durable]
mode = "temporal-embedded" # none | temporal-embedded | temporal-remote

[[mcp.servers]] # tools come from MCP servers
id = "orders"
transport = "stdio"
command = "orders-mcp"

[[agents]] # other agents, reached over A2A
id = "billing"
card_url = "https://billing.example/.well-known/agent-card.json"

[[providers.compatible]] # any OpenAI-compatible endpoint
id = "local"
base_url = "http://localhost:11434/v1"
models = ["llama4"]

[o11y]
log_file = "/var/log/yaah.log" # JSON lines; stderr when unset
otlp_endpoint = "http://localhost:4318" # OpenTelemetry traces
```

The whole schema is [`specs/config/config.schema.json`](specs/config/config.schema.json).
An unknown key, a bad value or a missing credential stops start-up and names the file,
the key and the reason.

With a Temporal mode the Temporal Web UI address is printed at start, published in the
agent card, and linked from every task.

## Use it as a library

Everything the command does goes through the package's public API.

```ts
import { createHarness, defineTool, loadConfig, registerEntity, textResult } from '@yaah/yaah';

const { config } = await loadConfig();
const harness = await createHarness({
  config,
  setup: (ctx) => {
    registerEntity(
      ctx,
      defineTool({
        id: 'lookup_order',
        description: 'Looks up an order by its id.',
        inputSchema: {
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        },
        invoke: async (args) => textResult(await orders.find(args)),
      }),
    );
  },
});
console.log(harness.ctx.http.url); // an A2A 1.0 server: JSON-RPC at /a2a, HTTP+JSON at /a2a/rest
```

Every directory of the source tree is a subpath (`@yaah/yaah/kernel`,
`@yaah/yaah/surface`, `@yaah/yaah/testing`, …); the full list of exports is
[`specs/api/exports.json`](specs/api/exports.json). A build is a YAML composition of
plugins, and any plugin can be replaced by id — see
[the architecture](docs/architecture/architecture.md#extending-yaah).

## Run it in a browser

`bun run build:browser` builds the harness and the web chat into `dist/browser/`: a
static site. Serve the directory with any file server and the whole harness — the loop,
the stores, the A2A request handling, the model providers — runs in the tab. There is no
yaah server; the chat reaches the harness through an in-memory A2A transport.

The build is the composition [`src/compositions/browser.yml`](src/compositions/browser.yml),
resolved at build time. It leaves out what needs Node — the listener, SQLite, Temporal,
the log file and tracing, stdio MCP servers, skills and agent plugins read from disk, and
A2UI — and keeps tasks in memory, so they last as long as the tab. A plugin that needs
Node says so (`export const runtime = ['node']`), and a composition that includes one
fails the build with the entry's name.

The page reads `config.toml` from beside `index.html` — the same keys as above. A tab has
no environment, so there is nowhere safe to keep a key:

- **Point it at a backend of yours** (the default to aim for): an OpenAI-compatible
  `base_url` that needs no key, where a server adds the real one.

  ```toml
  [model]
  llm = "proxy/your-model"
  
  [[providers.compatible]]
  id = "proxy"
  base_url = "https://your-backend.example/v1"
  models = ["your-model"]
  ```

- **Or hand the page your own key**, for your own use: set
  `globalThis.yaah = { credentials: { OPENAI_API_KEY: "sk-…" } }` in a script before the
  application's. **Anyone using that browser can read it** — in the page's memory and in
  every request it makes. Never ship a page with a key in it.

To embed the harness in a page of your own, `@yaah/yaah/browser` exports
`createBrowserHarness({ composition, config, credentials, setup })` and the in-memory
transport; `HarnessSession.connect(harness.ctx.harnessTarget)` connects a surface to it.

## Documentation

| Where                                                     | What                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/architecture/`](docs/architecture/architecture.md) | How the pieces fit: layers, one request, the loop, durability |
| [`docs/capabilities/`](docs/capabilities/capabilities.md) | What yaah does today, capability by capability                |
| [`docs/decisions/`](docs/decisions/decisions.md)          | Why it is built this way                                      |
| [`docs/specs/`](docs/specs/)                              | The requirements, design and test plan of each work item      |
| [`specs/`](specs/)                                        | Machine-readable contracts: config, A2A extensions, exports   |

## Development

Requires [Bun](https://bun.sh) ≥ 1.4; the tests also run on Node. Everything is
TypeScript, ESM-only.

```sh
bun install        # installs deps and the git hooks (lefthook)
bun run check      # everything CI runs: format, lint, typecheck, test, build, package test
```

| Script                  | What it does                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `bun run build`         | Compiles `src/` to `dist/` with `tsc`, copies compositions and prompts, builds the web chat |
| `bun run test`          | Unit, contract, integration and security tests with coverage (90% per file)                 |
| `bun run test:node`     | The same tests on Node, under Vitest                                                        |
| `bun run build:browser` | Builds the browser build — harness and web chat as a static site — into `dist/browser/`     |
| `bun run test:e2e`      | The web chat and the browser build in Chromium (Playwright), with accessibility checks      |
| `bun run test:package`  | Builds, then starts the built command with `node` and talks to it over A2A                  |
| `bun run test:chaos`    | Kills a harness mid-turn (SIGKILL) and checks the task resumes                              |
| `bun run test:live`     | Real providers; needs keys in the environment or the keyring, skips without                 |
| `bun run specs:update`  | Regenerates `specs/` after an intended contract change                                      |
| `bun run lint`          | `oxlint` with type-aware rules, warnings fail                                               |
| `bun run format`        | `oxfmt` (use `format:check` to verify only)                                                 |
| `bun run typecheck`     | `tsc --noEmit` under a strict `tsconfig.json`                                               |

Git hooks (`lefthook.yml`) mirror CI (`.github/workflows/ci.yml`):

- **pre-commit** — format check, lint, typecheck, test.
- **commit-msg** — [commitlint](https://commitlint.js.org) with the Conventional Commits preset.
- **pre-push** — `bun run check`.

CI also lints every commit in a pull request and the PR title.

This repository is developed with [the-loop](https://github.com/MadaraUchiha-314/the-loop);
see [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
