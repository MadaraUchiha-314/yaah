/**
 * The shape of yaah's configuration as code reads it: camelCase, every default applied.
 * The file itself is TOML with snake_case keys — see `config.ts`.
 */
import type { EntryOverride } from './bootstrap.ts';

/** How durable execution runs. */
export type DurableMode = 'none' | 'temporal-embedded' | 'temporal-remote';

/** One MCP server the harness connects to. */
export interface McpServerConfig {
  readonly id: string;
  readonly transport: 'stdio' | 'http';
  /** stdio: the executable to start. */
  readonly command: string | undefined;
  readonly args: readonly string[];
  /** stdio: names of environment variables passed through to the server. */
  readonly env: readonly string[];
  /** http: the Streamable HTTP endpoint. */
  readonly url: string | undefined;
}

/** One sub-agent, declared by the URL of its agent card. */
export interface AgentConfig {
  readonly id: string;
  readonly cardUrl: string;
}

/** An OpenAI-compatible endpoint (OpenRouter, Ollama, …). */
export interface CompatibleProviderConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string | undefined;
  /** Model ids served by this endpoint; each is registered as `<id>/<model>`. */
  readonly models: readonly string[];
  /** Context window assumed for this endpoint's models. */
  readonly contextWindow: number;
  /** Maximum output assumed for this endpoint's models. */
  readonly maxOutput: number;
  /** Input modalities beyond text the endpoint's models accept. */
  readonly input: readonly ('image' | 'audio')[];
}

/** The validated configuration, with every default applied. */
export interface YaahConfig {
  /** `"cli"`, `"server"`, or a path to a root `cordis.yaml`. */
  readonly composition: string;
  readonly locale: string;
  /** Where the stores and the embedded Temporal database live. Empty means `~/.yaah/data`. */
  readonly dataDir: string;
  readonly model: { readonly llm: string; readonly effort: string };
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly allowedOrigins: readonly string[];
    /**
     * Which proxies in front of the listener to believe about the client's address: none
     * (false), the nearest one (true), that many hops, or those addresses and subnets.
     */
    readonly trustProxy: boolean | number | readonly string[];
  };
  readonly providers: {
    readonly openai: {
      readonly apiKeyEnv: string;
      readonly baseUrl: string | undefined;
      /** Model ids registered as `openai/<model>`. */
      readonly models: readonly string[];
      /** The decisions model registered as the `system-one` entity `openai/<model>`. */
      readonly systemOneModel: string;
      /** The transcription model registered as the `speech-to-text` entity `openai/<model>`. */
      readonly sttModel: string;
      /** The Realtime model registered as the `text-to-speech` entity `openai/<model>`. */
      readonly ttsModel: string;
      /** The voice the text-to-speech model speaks with. */
      readonly ttsVoice: string;
      /** The image model behind the `generate_image` tool. */
      readonly imageModel: string;
    };
    readonly anthropic: {
      readonly apiKeyEnv: string;
      /** Model ids registered as `anthropic/<model>`. */
      readonly models: readonly string[];
    };
    readonly compatible: readonly CompatibleProviderConfig[];
  };
  readonly durable: {
    readonly mode: DurableMode;
    /** How a failed step is attempted again: exponential backoff, bounded. */
    readonly retry: {
      readonly initialIntervalMs: number;
      readonly backoffCoefficient: number;
      readonly maximumIntervalMs: number;
      readonly maximumAttempts: number;
    };
    readonly temporal: {
      readonly address: string;
      readonly namespace: string;
      readonly apiKeyEnv: string;
      readonly taskQueue: string;
      readonly port: number;
      readonly uiPort: number;
      readonly uiUrl: string | undefined;
      readonly encryptionKeyEnv: string | undefined;
    };
  };
  readonly limits: {
    readonly maxIterations: number;
    readonly maxAgentDepth: number;
    readonly maxBodyBytes: number;
    readonly maxParts: number;
    readonly maxPartBytes: number;
    readonly maxOpenTasksPerCaller: number;
    readonly maxRequestsPerMinute: number;
    readonly maxTaskTokens: number;
  };
  readonly compaction: { readonly threshold: number; readonly keepRecentFraction: number };
  readonly heartbeat: { readonly intervalMs: number; readonly stalledAfterMs: number };
  readonly o11y: {
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
    /** Log records are appended to this file instead of being written to standard error. */
    readonly logFile: string | undefined;
    /** Base URL of an OTLP/HTTP collector; spans go to `<url>/v1/traces`. */
    readonly otlpEndpoint: string | undefined;
    readonly captureContent: boolean;
    /**
     * Export spans to Langfuse's OTLP endpoint, `<host>/api/public/otel/v1/traces`. The
     * two variables hold the project's public and secret key. Ignored when `otlpEndpoint`
     * is set.
     */
    readonly langfuse:
      | {
          readonly host: string;
          readonly publicKeyEnv: string;
          readonly secretKeyEnv: string;
        }
      | undefined;
  };
  readonly inbox: {
    /**
     * `system-one`: a message that arrives for a working task without saying whether it
     * interrupts is classified by a System One model. `off`: it never interrupts.
     */
    readonly triage: 'off' | 'system-one';
    /** The id of the `system-one` entity triage asks. Defaults to OpenAI's. */
    readonly triageModel: string;
  };
  readonly speech: {
    /**
     * The id of the `speech-to-text` entity that transcribes audio for a model that does
     * not accept it. Empty means none: such a turn is answered with a refusal.
     */
    readonly stt: string;
    /** The id of the `text-to-speech` entity that speaks answers. Empty means none. */
    readonly tts: string;
  };
  readonly a2a: { readonly allowedHosts: readonly string[] };
  readonly mcp: { readonly servers: readonly McpServerConfig[] };
  readonly agents: readonly AgentConfig[];
  readonly skills: { readonly paths: readonly string[] };
  readonly plugins: readonly { readonly path: string }[];
  readonly overrides: readonly EntryOverride[];
}
