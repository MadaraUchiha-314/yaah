import { afterEach, describe, expect, test } from 'bun:test';

import { spanExporter } from '../../src/app/o11y/exporter.ts';
import { defaultConfig } from '../../src/kernel/config.ts';
import { Redactor } from '../../src/kernel/redactor.ts';
import { say } from '../../src/testing/scripted-llm.ts';
import type { TestHarness } from '../support/harness.ts';
import { startHarness } from '../support/harness.ts';
import type { Collector } from '../support/otlp.ts';
import { startCollector } from '../support/otlp.ts';

const PUBLIC_ENV = 'YAAH_TEST_LANGFUSE_PUBLIC_KEY';
const SECRET_ENV = 'YAAH_TEST_LANGFUSE_SECRET_KEY';
const PUBLIC_KEY = 'pk-lf-fixture-public-0001';
const SECRET_KEY = 'sk-lf-fixture-secret-0001';
const TRACES = '/api/public/otel/v1/traces';

let running: TestHarness | undefined = undefined;
let collector: Collector | undefined = undefined;

afterEach(async () => {
  await running?.stop();
  await collector?.stop();
  running = undefined;
  collector = undefined;
  delete process.env[PUBLIC_ENV];
  delete process.env[SECRET_ENV];
});

function langfuse(host: string): string {
  return [
    '[o11y.langfuse]',
    `host = "${host}"`,
    `public_key_env = "${PUBLIC_ENV}"`,
    `secret_key_env = "${SECRET_ENV}"`,
  ].join('\n');
}

async function startFailure(config: string): Promise<unknown> {
  try {
    running = await startHarness({ turns: [], config });
  } catch (error) {
    return error;
  }
  return null;
}

interface CredentialFailure {
  readonly code: string;
  readonly key: string;
  readonly message: string;
}

/**
 * The credential error at the bottom of a start-up failure. Matched by shape: under
 * Vitest the composition loads its own copy of the error classes.
 */
function credentialFailure(error: unknown): CredentialFailure | null {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && current.code === 'config.credential' && 'key' in current) {
      return { code: current.code, key: String(current.key), message: current.message };
    }
    current = current.cause;
  }
  return null;
}

describe('langfuse', () => {
  /**
   * Feature: Observability
   * Scenario: With Langfuse configured, spans are exported to its OTLP endpoint
   *   Given a harness with `o11y.langfuse` naming a host and two key variables that are set
   *   When a message is answered and the harness stops
   *   Then the model call's span arrives at `<host>/api/public/otel/v1/traces`
   *   And every request carries `Authorization: Basic base64(public:secret)`
   *   And neither key appears in what was exported
   * Requirement: docs/specs/issue-3/requirements.md R18.4, R18.5
   */
  test('With Langfuse configured, spans are exported to its OTLP endpoint', async () => {
    collector = await startCollector();
    process.env[PUBLIC_ENV] = PUBLIC_KEY;
    process.env[SECRET_ENV] = SECRET_KEY;
    running = await startHarness({
      turns: [say('On its way.')],
      config: langfuse(`${collector.url}/`),
    });
    const { redactor } = running.harness.ctx;
    await running.send('Where is my order?');
    await running.stop();
    running = undefined;

    const token = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');
    expect(collector.requests.length).toBeGreaterThan(0);
    expect([...new Set(collector.requests.map((request) => request.path))]).toEqual([TRACES]);
    for (const request of collector.requests) {
      expect(request.headers['authorization']).toBe(`Basic ${token}`);
      expect(request.headers['x-langfuse-ingestion-version']).toBe('4');
    }
    const chat = collector.spans.filter((span) => span.name === 'chat scripted/model');
    expect(chat).toHaveLength(1);
    expect(chat[0]?.attributes['gen_ai.operation.name']).toBe('chat');
    expect(collector.body()).not.toContain(SECRET_KEY);
    expect(redactor.contains(PUBLIC_KEY)).toBe(true);
    expect(redactor.contains(SECRET_KEY)).toBe(true);
    expect(redactor.contains(`Basic ${token}`)).toBe(true);
  });

  /**
   * Feature: Observability
   * Scenario: A missing Langfuse key stops start-up
   *   Given `o11y.langfuse` naming a key variable that is not set
   *   When the harness starts
   *   Then start-up fails with the credential error naming the variable and the config key
   * Requirement: docs/specs/issue-3/requirements.md R18.5
   */
  test('A missing Langfuse key stops start-up', async () => {
    process.env[PUBLIC_ENV] = PUBLIC_KEY;
    const missingSecret = credentialFailure(
      await startFailure(langfuse('https://langfuse.example')),
    );
    expect(missingSecret?.code).toBe('config.credential');
    expect(missingSecret?.key).toBe('o11y.langfuse.secret_key_env');
    expect(missingSecret?.message).toBe(
      `Environment variable ${SECRET_ENV} (named by o11y.langfuse.secret_key_env in config.toml) is not set.`,
    );
    delete process.env[PUBLIC_ENV];
    process.env[SECRET_ENV] = SECRET_KEY;
    const missingPublic = credentialFailure(
      await startFailure(langfuse('https://langfuse.example')),
    );
    expect(missingPublic?.key).toBe('o11y.langfuse.public_key_env');
    expect(missingPublic?.message).toContain(PUBLIC_ENV);
  });

  test('an OTLP endpoint wins over Langfuse, and neither means no exporter', () => {
    const base = defaultConfig().o11y;
    const redactor = new Redactor();
    expect(spanExporter(base, redactor)).toBeUndefined();
    const both = {
      ...base,
      otlpEndpoint: 'http://127.0.0.1:4318',
      langfuse: {
        host: 'https://langfuse.example',
        publicKeyEnv: PUBLIC_ENV,
        secretKeyEnv: SECRET_ENV,
      },
    };
    // The key variables are not set: reading them would throw.
    expect(spanExporter(both, redactor)).toBeDefined();
  });
});
