/** Small media for tests: a PNG, a WAV, a scripted Realtime socket, and A2A file parts. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Part } from '@a2a-js/sdk';

import type {
  RealtimeSocket,
  RealtimeSocketFactory,
} from '../../src/harness/models/speech/openai-tts/provider.ts';

/** A 1x1 PNG, base64-encoded. */
export const PNG_1X1: string =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A few bytes that say they are a WAV file, base64-encoded. Never decoded as audio. */
export const WAV_STUB: string = Buffer.from('RIFF$\u0000\u0000\u0000WAVEfmt ', 'latin1').toString(
  'base64',
);

/** An A2A `raw` part holding `base64` content of type `mediaType`. */
export function rawPart(mediaType: string, base64: string, filename = ''): Part {
  const content = { $case: 'raw', value: Buffer.from(base64, 'base64') } as const;
  return { content, mediaType, filename, metadata: undefined };
}

/** An A2A `url` part. */
export function urlPart(mediaType: string, url: string): Part {
  return { content: { $case: 'url', value: url }, mediaType, filename: '', metadata: undefined };
}

/** A fixture under `test/fixtures/`. */
export function mediaFixture(...path: readonly string[]): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', ...path), 'utf8');
}

/** One scripted Realtime connection: what it was opened with and what was sent on it. */
export interface ScriptedConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The client events sent, parsed. */
  readonly sent: unknown[];
  closed: boolean;
}

/** A socket factory that plays server events from a script, and what it recorded. */
export interface ScriptedSockets {
  readonly open: RealtimeSocketFactory;
  readonly connections: ScriptedConnection[];
}

/** What a scripted socket does once the client has asked for a response. */
export type SocketScript =
  /** Sends these server events (JSON lines), in order. */
  | { readonly events: string }
  /** Drops the connection without a word. */
  | { readonly drop: true }
  /** Never answers. */
  | { readonly silent: true };

/**
 * Stands in for the Realtime API: every socket opens, and once the client sends
 * `response.create` the script is played back, one event per tick.
 */
export function scriptedSockets(script: SocketScript): ScriptedSockets {
  const connections: ScriptedConnection[] = [];
  const open: RealtimeSocketFactory = (url, headers): RealtimeSocket => {
    const connection: ScriptedConnection = { url, headers, sent: [], closed: false };
    connections.push(connection);
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    const emit = (type: string, data?: unknown): void => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ data });
      }
    };
    const play = async (): Promise<void> => {
      if ('drop' in script) {
        emit('close');
      } else if ('events' in script) {
        for (const line of script.events.split('\n').filter((text) => text.trim() !== '')) {
          // oxlint-disable-next-line no-await-in-loop -- events arrive one after another
          await Promise.resolve();
          if (!connection.closed) {
            emit('message', line);
          }
        }
      }
    };
    queueMicrotask(() => {
      emit('open');
    });
    return {
      send: (data: string): void => {
        const event: unknown = JSON.parse(data);
        connection.sent.push(event);
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'response.create'
        ) {
          void play();
        }
      },
      close: (): void => {
        connection.closed = true;
      },
      addEventListener: (type, listener): void => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    };
  };
  return { open, connections };
}
