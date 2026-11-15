import { describe, expect, test } from 'bun:test';

import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

import { classifyFailure, failureResult, mapCallResult, toJson } from './result.ts';

describe('mapCallResult', () => {
  test('maps text content to text parts', () => {
    expect(mapCallResult({ content: [{ type: 'text', text: 'one' }] })).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'one' }],
    });
  });

  test('maps image and audio content to base64 file parts', () => {
    const result = mapCallResult({
      content: [
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVk', mimeType: 'audio/wav' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      content: [
        { type: 'file', mediaType: 'image/png', source: { kind: 'base64', data: 'aW1n' } },
        { type: 'file', mediaType: 'audio/wav', source: { kind: 'base64', data: 'YXVk' } },
      ],
    });
  });

  test('maps embedded resources and resource links', () => {
    const result = mapCallResult({
      content: [
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } },
        { type: 'resource', resource: { uri: 'file:///a.bin', blob: 'Ymlu' } },
        {
          type: 'resource',
          resource: { uri: 'file:///a.pdf', blob: 'cGRm', mimeType: 'application/pdf' },
        },
        { type: 'resource_link', uri: 'https://example.test/doc', name: 'doc' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      content: [
        { type: 'text', text: 'body' },
        {
          type: 'file',
          mediaType: 'application/octet-stream',
          source: { kind: 'base64', data: 'Ymlu' },
          name: 'file:///a.bin',
        },
        {
          type: 'file',
          mediaType: 'application/pdf',
          source: { kind: 'base64', data: 'cGRm' },
          name: 'file:///a.pdf',
        },
        { type: 'text', text: 'https://example.test/doc' },
      ],
    });
  });

  test('carries structured content', () => {
    const result = mapCallResult({ content: [], structuredContent: { id: 'a1', n: [1, null] } });
    expect(result).toEqual({ ok: true, content: [], structured: { id: 'a1', n: [1, null] } });
  });

  test('leaves structured content out when it is not JSON', () => {
    expect(mapCallResult({ content: [], structuredContent: 10n })).toEqual({
      ok: true,
      content: [],
    });
  });

  test('turns an error result into a tool error with the joined text', () => {
    const result = mapCallResult({
      isError: true,
      content: [
        { type: 'text', text: 'No such order.' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        { type: 'text', text: 'Try another id.' },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'tool-error', message: 'No such order.\nTry another id.' },
    });
  });

  test('gives an error result without text a message', () => {
    const result = mapCallResult({ isError: true, content: [] });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).not.toBe('');
  });
});

describe('toJson', () => {
  test('keeps JSON values and drops undefined properties', () => {
    expect(toJson({ a: 1, b: undefined, c: ['x', true, null, { d: 2 }] })).toEqual({
      a: 1,
      c: ['x', true, null, { d: 2 }],
    });
  });

  test('refuses values JSON cannot carry', () => {
    expect(toJson(undefined)).toBeUndefined();
    expect(toJson(Number.NaN)).toBeUndefined();
    expect(toJson(() => 1)).toBeUndefined();
    expect(toJson({ a: { b: 1n } })).toBeUndefined();
    expect(toJson([Symbol('x')])).toBeUndefined();
  });
});

describe('call failures', () => {
  test('an aborted call is reported as cancelled', () => {
    expect(classifyFailure(new Error('aborted'), true)).toBe('cancelled');
  });

  test('a request timeout is reported as a timeout', () => {
    expect(classifyFailure(new SdkError(SdkErrorCode.RequestTimeout, 'too slow'), false)).toBe(
      'timeout',
    );
  });

  test('an error answer from the server is a tool error', () => {
    expect(classifyFailure(new ProtocolError(-32_602, 'Tool nope not found'), false)).toBe(
      'tool-error',
    );
  });

  test('anything else means the server could not be reached', () => {
    expect(classifyFailure(new Error('Not connected'), false)).toBe('unavailable');
    expect(classifyFailure(new SdkError(SdkErrorCode.ConnectionClosed, 'closed'), false)).toBe(
      'unavailable',
    );
    expect(classifyFailure('boom', false)).toBe('unavailable');
  });

  test('the result carries the kind as its code and the error text as its message', () => {
    expect(failureResult(new Error('Not connected'), false)).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Not connected' },
    });
    expect(failureResult('boom', false)).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'boom' },
    });
  });
});
