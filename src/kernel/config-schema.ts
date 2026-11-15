/**
 * The schema of `config.toml` (snake_case, as written in the file) and its mapping to
 * {@link YaahConfig}. Unknown keys are rejected at every level.
 */
import { z } from 'zod';

import { toInbox, toO11y } from './config-sections.ts';
import type { YaahConfig } from './config-types.ts';
import type { Json } from './json.ts';

const jsonValue: z.ZodType<Json> = z.json();

const fileSchema = z.strictObject({
  composition: z.string().default('cli'),
  locale: z.string().default('en'),
  data_dir: z.string().default(''),
  model: z
    .strictObject({
      llm: z.string().default('openai/gpt-6.1-sol'),
      effort: z.string().default('medium'),
    })
    .prefault({}),
  server: z
    .strictObject({
      host: z.string().default('127.0.0.1'),
      port: z.int().min(0).max(65_535).default(7420),
      allowed_origins: z.array(z.string()).default([]),
      // true (one proxy), a hop count, or the proxies' addresses and subnets.
      trust_proxy: z.union([z.boolean(), z.int().min(0), z.array(z.string())]).default(false),
    })
    .prefault({}),
  providers: z
    .strictObject({
      openai: z
        .strictObject({
          api_key_env: z.string().default('OPENAI_API_KEY'),
          base_url: z.string().optional(),
          models: z.array(z.string()).default(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra']),
          system_one_model: z.string().default('gpt-6-luna'),
          stt_model: z.string().default('gpt-transcribe'),
          tts_model: z.string().default('gpt-realtime-2.1-mini'),
          tts_voice: z.string().default('marin'),
          image_model: z.string().default('gpt-image-2.5-flare'),
        })
        .prefault({}),
      anthropic: z
        .strictObject({
          api_key_env: z.string().default('ANTHROPIC_API_KEY'),
          models: z
            .array(z.string())
            .default([
              'claude-opus-5-5',
              'claude-sonnet-5-5',
              'claude-haiku-5-5',
              'claude-fable-5-2',
            ]),
        })
        .prefault({}),
      compatible: z
        .array(
          z.strictObject({
            id: z.string(),
            base_url: z.string(),
            api_key_env: z.string().optional(),
            models: z.array(z.string()).default([]),
            context_window: z.int().min(1).default(128_000),
            max_output: z.int().min(1).default(8192),
            input: z.array(z.enum(['image', 'audio'])).default([]),
          }),
        )
        .default([]),
    })
    .prefault({}),
  durable: z
    .strictObject({
      mode: z.enum(['none', 'temporal-embedded', 'temporal-remote']).default('none'),
      retry: z
        .strictObject({
          initial_interval_ms: z.int().min(1).default(1000),
          backoff_coefficient: z.number().min(1).default(2),
          maximum_interval_ms: z.int().min(1).default(60_000),
          maximum_attempts: z.int().min(1).default(5),
        })
        .prefault({}),
      temporal: z
        .strictObject({
          address: z.string().default(''),
          namespace: z.string().default('default'),
          api_key_env: z.string().default('TEMPORAL_API_KEY'),
          task_queue: z.string().default('yaah'),
          port: z.int().min(1).max(65_535).default(7233),
          ui_port: z.int().min(1).max(65_535).default(8233),
          ui_url: z.string().optional(),
          encryption_key_env: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  limits: z
    .strictObject({
      max_iterations: z.int().min(1).default(50),
      max_agent_depth: z.int().min(0).default(3),
      max_body_bytes: z.int().min(1).default(10_485_760),
      max_parts: z.int().min(1).default(32),
      max_part_bytes: z.int().min(1).default(8_388_608),
      max_open_tasks_per_caller: z.int().min(1).default(20),
      max_requests_per_minute: z.int().min(1).default(120),
      max_task_tokens: z.int().min(1).default(2_000_000),
    })
    .prefault({}),
  compaction: z
    .strictObject({
      threshold: z.number().gt(0).max(1).default(0.8),
      keep_recent_fraction: z.number().gt(0).lt(1).default(0.2),
    })
    .prefault({}),
  heartbeat: z
    .strictObject({
      interval_ms: z.int().min(100).default(30_000),
      stalled_after_ms: z.int().min(100).default(300_000),
    })
    .prefault({}),
  o11y: z
    .strictObject({
      log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      log_file: z.string().optional(),
      otlp_endpoint: z.string().optional(),
      capture_content: z.boolean().default(false),
      langfuse: z
        .strictObject({
          host: z.string(),
          public_key_env: z.string(),
          secret_key_env: z.string(),
        })
        .optional(),
    })
    .prefault({}),
  inbox: z
    .strictObject({
      triage: z.enum(['off', 'system-one']).default('off'),
      triage_model: z.string().optional(),
    })
    .prefault({}),
  speech: z.strictObject({ stt: z.string().default(''), tts: z.string().default('') }).prefault({}),
  a2a: z.strictObject({ allowed_hosts: z.array(z.string()).default([]) }).prefault({}),
  mcp: z
    .strictObject({
      servers: z
        .array(
          z.strictObject({
            id: z.string(),
            transport: z.enum(['stdio', 'http']),
            command: z.string().optional(),
            args: z.array(z.string()).default([]),
            env: z.array(z.string()).default([]),
            url: z.string().optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  agents: z.array(z.strictObject({ id: z.string(), card_url: z.string() })).default([]),
  skills: z.strictObject({ paths: z.array(z.string()).default([]) }).prefault({}),
  plugins: z.array(z.strictObject({ path: z.string() })).default([]),
  overrides: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string().optional(),
        config: jsonValue.optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .default([]),
});

type FileConfig = z.output<typeof fileSchema>;

function toProviders(file: FileConfig): YaahConfig['providers'] {
  return {
    openai: {
      apiKeyEnv: file.providers.openai.api_key_env,
      baseUrl: file.providers.openai.base_url,
      models: file.providers.openai.models,
      systemOneModel: file.providers.openai.system_one_model,
      sttModel: file.providers.openai.stt_model,
      ttsModel: file.providers.openai.tts_model,
      ttsVoice: file.providers.openai.tts_voice,
      imageModel: file.providers.openai.image_model,
    },
    anthropic: {
      apiKeyEnv: file.providers.anthropic.api_key_env,
      models: file.providers.anthropic.models,
    },
    compatible: file.providers.compatible.map((provider) => ({
      id: provider.id,
      baseUrl: provider.base_url,
      apiKeyEnv: provider.api_key_env,
      models: provider.models,
      contextWindow: provider.context_window,
      maxOutput: provider.max_output,
      input: provider.input,
    })),
  };
}

function toDurable(file: FileConfig): YaahConfig['durable'] {
  const { temporal } = file.durable;
  return {
    mode: file.durable.mode,
    retry: {
      initialIntervalMs: file.durable.retry.initial_interval_ms,
      backoffCoefficient: file.durable.retry.backoff_coefficient,
      maximumIntervalMs: file.durable.retry.maximum_interval_ms,
      maximumAttempts: file.durable.retry.maximum_attempts,
    },
    temporal: {
      address: temporal.address,
      namespace: temporal.namespace,
      apiKeyEnv: temporal.api_key_env,
      taskQueue: temporal.task_queue,
      port: temporal.port,
      uiPort: temporal.ui_port,
      uiUrl: temporal.ui_url,
      encryptionKeyEnv: temporal.encryption_key_env,
    },
  };
}

function toLimits(file: FileConfig): YaahConfig['limits'] {
  return {
    maxIterations: file.limits.max_iterations,
    maxAgentDepth: file.limits.max_agent_depth,
    maxBodyBytes: file.limits.max_body_bytes,
    maxParts: file.limits.max_parts,
    maxPartBytes: file.limits.max_part_bytes,
    maxOpenTasksPerCaller: file.limits.max_open_tasks_per_caller,
    maxRequestsPerMinute: file.limits.max_requests_per_minute,
    maxTaskTokens: file.limits.max_task_tokens,
  };
}

function toExtensions(
  file: FileConfig,
): Pick<YaahConfig, 'a2a' | 'mcp' | 'agents' | 'skills' | 'plugins' | 'overrides'> {
  return {
    a2a: { allowedHosts: file.a2a.allowed_hosts },
    mcp: {
      servers: file.mcp.servers.map((server) => ({
        ...server,
        command: server.command,
        url: server.url,
      })),
    },
    agents: file.agents.map((agent) => ({ id: agent.id, cardUrl: agent.card_url })),
    skills: file.skills,
    plugins: file.plugins,
    overrides: file.overrides,
  };
}

function toConfig(file: FileConfig): YaahConfig {
  return {
    composition: file.composition,
    locale: file.locale,
    dataDir: file.data_dir,
    model: file.model,
    server: {
      host: file.server.host,
      port: file.server.port,
      allowedOrigins: file.server.allowed_origins,
      trustProxy: file.server.trust_proxy,
    },
    providers: toProviders(file),
    durable: toDurable(file),
    limits: toLimits(file),
    compaction: {
      threshold: file.compaction.threshold,
      keepRecentFraction: file.compaction.keep_recent_fraction,
    },
    heartbeat: {
      intervalMs: file.heartbeat.interval_ms,
      stalledAfterMs: file.heartbeat.stalled_after_ms,
    },
    o11y: toO11y(file.o11y),
    inbox: toInbox(file.inbox, file.providers.openai.system_one_model),
    speech: file.speech,
    ...toExtensions(file),
  };
}

/** One reason a configuration object was rejected. */
export interface ConfigIssue {
  /** The dotted, snake_case key at fault, as written in the file. */
  readonly key: string;
  readonly reason: string;
}

/** The outcome of {@link validateConfig}. */
export type ConfigValidation =
  | { readonly ok: true; readonly config: YaahConfig }
  | { readonly ok: false; readonly issue: ConfigIssue };

/** Validates a parsed TOML document and applies every default. */
export function validateConfig(raw: unknown): ConfigValidation {
  const result = fileSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, config: toConfig(result.data) };
  }
  const [issue] = result.error.issues;
  const path = issue?.path.map(String) ?? [];
  const unknownKeys = issue?.code === 'unrecognized_keys' ? issue.keys : [];
  return {
    ok: false,
    issue: { key: [...path, ...unknownKeys.slice(0, 1)].join('.'), reason: issue?.message ?? '' },
  };
}

/** The JSON Schema of the configuration file, published as `specs/config/config.schema.json`. */
export function configJsonSchema(): Json {
  return jsonValue.parse(z.toJSONSchema(fileSchema, { io: 'input' }));
}
