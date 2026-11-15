import { describe, expect, test } from 'bun:test';

import { MAX_TOOL_ID_LENGTH, mcpToolId, serverIdsClash } from './naming.ts';

describe('mcpToolId', () => {
  test('joins the server id and the tool name', () => {
    expect(mcpToolId('crm', 'lookup_order')).toBe('mcp__crm__lookup_order');
  });

  test('keeps letters, digits, underscores and hyphens', () => {
    expect(mcpToolId('crm-2', 'Get-Order_v2')).toBe('mcp__crm-2__Get-Order_v2');
  });

  test('replaces every other character with an underscore', () => {
    expect(mcpToolId('my.crm', 'orders/get item')).toBe('mcp__my_crm__orders_get_item');
    expect(mcpToolId('crm', 'größe')).toBe('mcp__crm__gr__e');
  });

  test('accepts an id of exactly the maximum length', () => {
    const name = 'a'.repeat(MAX_TOOL_ID_LENGTH - 'mcp__crm__'.length);
    expect(mcpToolId('crm', name)).toHaveLength(MAX_TOOL_ID_LENGTH);
  });

  test('refuses an id longer than the maximum', () => {
    const name = 'a'.repeat(MAX_TOOL_ID_LENGTH - 'mcp__crm__'.length + 1);
    expect(mcpToolId('crm', name)).toBeNull();
  });

  test('refuses an empty tool name', () => {
    expect(mcpToolId('crm', '')).toBeNull();
  });
});

describe('serverIdsClash', () => {
  test('ids that are equal once sanitised clash', () => {
    expect(serverIdsClash('policy', 'policy')).toBe(true);
    expect(serverIdsClash('my.crm', 'my_crm')).toBe(true);
  });

  test('an id that is another followed by the separator clashes, either way round', () => {
    // `a` + `b__c` and `a__b` + `c` would both be `mcp__a__b__c`.
    expect(serverIdsClash('a', 'a__b')).toBe(true);
    expect(serverIdsClash('a__b', 'a')).toBe(true);
  });

  test('different ids do not clash', () => {
    expect(serverIdsClash('crm', 'policy')).toBe(false);
    expect(serverIdsClash('a', 'a_b')).toBe(false);
  });
});
