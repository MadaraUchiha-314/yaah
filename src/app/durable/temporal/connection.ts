/**
 * Reaching Temporal: a server the harness starts itself (embedded), or one that exists
 * already (remote — Temporal Cloud or a self-hosted cluster).
 */
import type { Connection } from '@temporalio/client';
import { Connection as ClientConnection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';

/** A connected Temporal service. */
export interface TemporalLink {
  readonly namespace: string;
  /** For starting and signalling workflows. */
  readonly connection: Connection;
  /** For the worker. */
  readonly nativeConnection: NativeConnection;
  /** The Temporal Web UI of the namespace. */
  readonly dashboardUrl: string;
  /** Closes the connections, and stops the server if this harness started it. */
  close(): Promise<void>;
}

/** Where a remote Temporal is. */
export interface RemoteOptions {
  readonly address: string;
  readonly namespace: string;
  /** Sent as a bearer token; also switches TLS on. */
  readonly apiKey: string | undefined;
  /** The Web UI, when it is not Temporal Cloud's. */
  readonly uiUrl: string | undefined;
}

/** How the embedded server is started. */
export interface EmbeddedOptions {
  readonly namespace: string;
  readonly port: number;
  readonly uiPort: number;
  /** Where the server keeps its data, so workflows survive a restart of the harness. */
  readonly dbFilename: string;
}

/** The Web UI address of a Temporal Cloud namespace. */
export function cloudDashboardUrl(namespace: string): string {
  return `https://cloud.temporal.io/namespaces/${encodeURIComponent(namespace)}`;
}

/** The Web UI address of a namespace on a local server. */
export function localDashboardUrl(uiPort: number, namespace: string): string {
  return `http://127.0.0.1:${String(uiPort)}/namespaces/${encodeURIComponent(namespace)}`;
}

/**
 * Connects to an existing Temporal service.
 *
 * @throws when the service cannot be reached — the caller fails start-up; there is no
 *   fallback to another mode.
 */
export async function connectRemote(options: RemoteOptions): Promise<TemporalLink> {
  const secure = options.apiKey !== undefined;
  const shared = {
    address: options.address,
    ...(secure ? { tls: true, apiKey: options.apiKey } : {}),
  };
  const connection = await ClientConnection.connect(shared);
  const nativeConnection = await NativeConnection.connect(shared);
  return {
    namespace: options.namespace,
    connection,
    nativeConnection,
    dashboardUrl: options.uiUrl ?? cloudDashboardUrl(options.namespace),
    close: async (): Promise<void> => {
      await nativeConnection.close();
      await connection.close();
    },
  };
}

/**
 * Starts Temporal's development server on loopback, with its Web UI, and connects to it.
 * The server binary is downloaded and cached on first use.
 */
export async function startEmbedded(options: EmbeddedOptions): Promise<TemporalLink> {
  // Loaded only in this mode: the package brings the server download machinery with it.
  const { TestWorkflowEnvironment } = await import('@temporalio/testing');
  const environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      port: options.port,
      ui: true,
      uiPort: options.uiPort,
      namespace: options.namespace,
      dbFilename: options.dbFilename,
    },
  });
  return {
    namespace: options.namespace,
    connection: environment.connection,
    nativeConnection: environment.nativeConnection,
    dashboardUrl: localDashboardUrl(options.uiPort, options.namespace),
    close: async (): Promise<void> => {
      await environment.teardown();
    },
  };
}
