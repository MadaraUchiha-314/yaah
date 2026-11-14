/** The file written on first run: every default, commented, and no secret. */
export const DEFAULT_CONFIG_TOML: string = `# yaah configuration. Every key is optional; what you see are the defaults.
# Credentials are never written here: a key ending in _env names an environment variable.

# "cli", "server", or a path to a root cordis.yaml of your own.
composition = "cli"
locale = "en"

[model]
llm = "openai/gpt-6.1-sol"
effort = "medium"

[server]
# The A2A API has no authentication. Keep it on loopback unless you add an auth plugin.
host = "127.0.0.1"
port = 7420
# Browser origins allowed besides the harness's own web UI.
allowed_origins = []

[providers.openai]
api_key_env = "OPENAI_API_KEY"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[durable]
# "none" | "temporal-embedded" | "temporal-remote"
mode = "none"

[durable.temporal]
# Remote mode: e.g. "your-namespace.account.tmprl.cloud:7233"
address = ""
namespace = "default"
api_key_env = "TEMPORAL_API_KEY"

[limits]
max_iterations = 50
max_agent_depth = 3
max_open_tasks_per_caller = 20
max_requests_per_minute = 120
max_task_tokens = 2000000

[compaction]
threshold = 0.8
keep_recent_fraction = 0.2

[inbox]
# "off" | "system-one": let a fast decisions model judge whether a message that arrives
# while the agent is working, and does not say so itself, should interrupt it.
triage = "off"

# Send traces to Langfuse. The two variables hold the project's public and secret key.
# [o11y.langfuse]
# host = "https://cloud.langfuse.com"
# public_key_env = "LANGFUSE_PUBLIC_KEY"
# secret_key_env = "LANGFUSE_SECRET_KEY"

# [[mcp.servers]]
# id = "orders"
# transport = "stdio"
# command = "orders-mcp"

# [[agents]]
# id = "billing"
# card_url = "https://billing.example/.well-known/agent-card.json"

# [[overrides]]
# id = "llm-openai"
# disabled = true
`;
