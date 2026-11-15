/**
 * Turning what an MCP server answers — or fails to answer — into the `ToolResult` the
 * core loop shows the model. Nothing here throws.
 */
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/client';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

import type { Json, JsonObject } from '../../../kernel/json.ts';
import { t } from '../../../kernel/strings.ts';
import type { ContentPart, ToolResult } from '../../core/types.ts';
import { errorResult } from '../types.ts';

/** The part of an MCP `tools/call` result this module reads. */
export type McpCallResult = Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>;

/** Media type of a binary resource whose server did not name one. */
const BINARY = 'application/octet-stream';

function objectToJson(value: object): JsonObject | undefined {
  const entries: [string, unknown][] = Object.entries(value);
  const out: Record<string, Json> = {};
  for (const [key, entry] of entries) {
    if (entry !== undefined) {
      const converted = toJson(entry);
      if (converted === undefined) {
        return undefined;
      }
      out[key] = converted;
    }
  }
  return out;
}

function arrayToJson(value: readonly unknown[]): Json | undefined {
  const out: Json[] = [];
  for (const entry of value) {
    const converted = toJson(entry);
    if (converted === undefined) {
      return undefined;
    }
    out.push(converted);
  }
  return out;
}

/**
 * Checks that a value from outside is JSON and returns it typed as such.
 *
 * Object properties whose value is `undefined` are dropped, as `JSON.stringify` would.
 *
 * @returns undefined when the value, or anything inside it, is not a JSON value (a
 *   function, a symbol, a bigint, a non-finite number, `undefined`).
 */
export function toJson(value: unknown): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return arrayToJson(items);
  }
  return typeof value === 'object' ? objectToJson(value) : undefined;
}

function toPart(block: ContentBlock): ContentPart {
  switch (block.type) {
    case 'text': {
      return { type: 'text', text: block.text };
    }
    case 'image':
    case 'audio': {
      return {
        type: 'file',
        mediaType: block.mimeType,
        source: { kind: 'base64', data: block.data },
      };
    }
    case 'resource': {
      const { resource } = block;
      return 'text' in resource
        ? { type: 'text', text: resource.text }
        : {
            type: 'file',
            mediaType: resource.mimeType ?? BINARY,
            source: { kind: 'base64', data: resource.blob },
            name: resource.uri,
          };
    }
    default: {
      // A resource link is passed on as text. The harness never fetches a URL a tool
      // returned, so it must not become a part with a URL source.
      return { type: 'text', text: block.uri };
    }
  }
}

function joinedText(content: readonly ContentBlock[]): string {
  return content
    .map((block: ContentBlock) => (block.type === 'text' ? block.text : ''))
    .filter((text: string) => text !== '')
    .join('\n');
}

/**
 * Maps a `tools/call` result to a `ToolResult`.
 *
 * - Text becomes text parts; images and audio become base64 file parts; an embedded
 *   resource becomes a text or a file part; a resource link becomes its URI as text.
 * - `structuredContent` is carried as `structured` when it is JSON.
 * - A result marked `isError` becomes `{ ok: false }` with code `tool-error` and the
 *   result's text as the message.
 */
export function mapCallResult(result: McpCallResult): ToolResult {
  if (result.isError === true) {
    const message = joinedText(result.content);
    return errorResult('tool-error', message === '' ? t('mcp.error.no-detail') : message);
  }
  const content = result.content.map((block: ContentBlock) => toPart(block));
  const structured = toJson(result.structuredContent);
  return structured === undefined ? { ok: true, content } : { ok: true, content, structured };
}

/**
 * Why a call did not produce a result. Also the `code` of the error shown to the model.
 *
 * - `cancelled`: the caller aborted it.
 * - `timeout`: the server did not answer in time.
 * - `tool-error`: the server answered with a protocol error (unknown tool, bad arguments).
 * - `unavailable`: the server could not be reached.
 */
export type FailureKind = 'cancelled' | 'timeout' | 'tool-error' | 'unavailable';

/**
 * Classifies an error thrown by a call.
 *
 * @param aborted Whether the caller's signal was aborted; takes precedence, because an
 *   abort surfaces from the SDK as a timeout.
 */
export function classifyFailure(error: unknown, aborted: boolean): FailureKind {
  if (aborted) {
    return 'cancelled';
  }
  if (error instanceof ProtocolError) {
    return 'tool-error';
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return 'timeout';
  }
  return 'unavailable';
}

/** The text of anything thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `ToolResult` for a call that threw: `{ ok: false }` with the failure kind as code. */
export function failureResult(error: unknown, aborted: boolean): ToolResult {
  return errorResult(classifyFailure(error, aborted), errorText(error));
}
