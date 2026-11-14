/**
 * Where spans are sent: an OTLP/HTTP collector named by `o11y.otlp_endpoint`, or
 * Langfuse, which is the same exporter pointed at Langfuse's OTLP endpoint with the
 * project's keys as HTTP Basic credentials.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

import type { YaahConfig } from '../../kernel/config-types.ts';
import { ConfigError } from '../../kernel/errors.ts';
import type { Redactor } from '../../kernel/redactor.ts';
import { t } from '../../kernel/strings.ts';

/** The path of Langfuse's OTLP endpoint under its host. */
export const LANGFUSE_OTLP_PATH = '/api/public/otel';

const CONFIG_FILE = 'config.toml';
const TRACES_PATH = '/v1/traces';

function tracesUrl(base: string): string {
  return `${base.replace(/\/$/u, '')}${TRACES_PATH}`;
}

/**
 * Reads the credential in the environment variable `variable`.
 *
 * @throws ConfigError (`config.credential`) naming the variable and `key` when it is not set.
 */
function credential(variable: string, key: string): string {
  const value = process.env[variable] ?? '';
  if (value === '') {
    const message = t('error.config.credential', { variable, key, file: CONFIG_FILE });
    throw new ConfigError('config.credential', message, CONFIG_FILE, key);
  }
  return value;
}

/**
 * Builds the exporter the configuration asks for, or `undefined` when it asks for none.
 * `o11y.otlp_endpoint` wins over `o11y.langfuse`. The Langfuse keys, and the header built
 * from them, are handed to `redactor`.
 *
 * @throws ConfigError (`config.credential`) when Langfuse is configured and one of the
 *   two environment variables it names is not set.
 */
export function spanExporter(
  config: YaahConfig['o11y'],
  redactor: Redactor,
): SpanExporter | undefined {
  if (config.otlpEndpoint !== undefined) {
    return new OTLPTraceExporter({ url: tracesUrl(config.otlpEndpoint) });
  }
  const { langfuse } = config;
  if (langfuse === undefined) {
    return undefined;
  }
  const publicKey = credential(langfuse.publicKeyEnv, 'o11y.langfuse.public_key_env');
  const secretKey = credential(langfuse.secretKeyEnv, 'o11y.langfuse.secret_key_env');
  const token = Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64');
  for (const secret of [publicKey, secretKey, token]) {
    redactor.add(secret);
  }
  return new OTLPTraceExporter({
    url: tracesUrl(`${langfuse.host.replace(/\/$/u, '')}${LANGFUSE_OTLP_PATH}`),
    headers: {
      Authorization: `Basic ${token}`,
      // Langfuse's documentation asks for this on spans sent straight over OTLP: without
      // it, ingestion can lag by minutes.
      'x-langfuse-ingestion-version': '4',
    },
  });
}
