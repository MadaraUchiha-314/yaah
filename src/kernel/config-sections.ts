/**
 * Mappings of single sections of `config.toml` (snake_case, as validated by the schema in
 * `config-schema.ts`) to their part of {@link YaahConfig}.
 */
import type { YaahConfig } from './config-types.ts';

/** The `[o11y]` section as the schema yields it. */
export interface O11ySection {
  readonly log_level: YaahConfig['o11y']['logLevel'];
  readonly log_file?: string | undefined;
  readonly otlp_endpoint?: string | undefined;
  readonly capture_content: boolean;
  readonly langfuse?:
    | {
        readonly host: string;
        readonly public_key_env: string;
        readonly secret_key_env: string;
      }
    | undefined;
}

/** The `[inbox]` section as the schema yields it. */
export interface InboxSection {
  readonly triage: YaahConfig['inbox']['triage'];
  readonly triage_model?: string | undefined;
}

/** Maps the `[o11y]` section. */
export function toO11y(section: O11ySection): YaahConfig['o11y'] {
  const { langfuse } = section;
  return {
    logLevel: section.log_level,
    logFile: section.log_file,
    otlpEndpoint: section.otlp_endpoint,
    captureContent: section.capture_content,
    langfuse:
      langfuse === undefined
        ? undefined
        : {
            host: langfuse.host,
            publicKeyEnv: langfuse.public_key_env,
            secretKeyEnv: langfuse.secret_key_env,
          },
  };
}

/**
 * Maps the `[inbox]` section. Without `triage_model`, triage asks OpenAI's decisions
 * model, `openai/<systemOneModel>`.
 */
export function toInbox(section: InboxSection, systemOneModel: string): YaahConfig['inbox'] {
  return {
    triage: section.triage,
    triageModel: section.triage_model ?? `openai/${systemOneModel}`,
  };
}
