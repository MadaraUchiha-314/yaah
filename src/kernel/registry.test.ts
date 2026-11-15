import { describe, expect, test } from 'bun:test';
import { Context } from 'cordis';

import { definePrompt } from '../harness/system-prompt/prompt.ts';
import { EntityConflictError, EntityNotFoundError } from './errors.ts';
import { EntityRegistry, registerEntity } from './registry.ts';

const hello = definePrompt({ id: 'hello', template: 'Hello' });
const helloV2 = definePrompt({ id: 'hello', version: '2', template: 'Hello again' });

describe('EntityRegistry', () => {
  test('resolves an unversioned entity by (id, null)', () => {
    const registry = new EntityRegistry();
    registry.register(hello);
    expect(registry.resolve({ kind: 'prompt', id: 'hello', version: null })).toBe(hello);
  });

  test('keeps versions apart and never substitutes one for another', () => {
    const registry = new EntityRegistry();
    registry.register(hello);
    registry.register(helloV2);
    expect(registry.resolve({ kind: 'prompt', id: 'hello', version: '2' })).toBe(helloV2);
    expect(() => registry.resolve({ kind: 'prompt', id: 'hello', version: '3' })).toThrow(
      EntityNotFoundError,
    );
  });

  test('throws a typed not-found error naming the reference', () => {
    const registry = new EntityRegistry();
    const ref = { kind: 'prompt', id: 'missing', version: null } as const;
    let caught: unknown = null;
    try {
      registry.resolve(ref);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EntityNotFoundError);
    if (caught instanceof EntityNotFoundError) {
      expect(caught.code).toBe('entity.not-found');
      expect(caught.ref).toEqual(ref);
    }
  });

  test('rejects a second registration under the same address', () => {
    const registry = new EntityRegistry();
    registry.register(hello);
    expect(() => registry.register(definePrompt({ id: 'hello', template: 'Other' }))).toThrow(
      EntityConflictError,
    );
  });

  test('replaces on an explicit override and restores the previous entry on dispose', () => {
    const registry = new EntityRegistry();
    registry.register(hello);
    const replacement = definePrompt({ id: 'hello', template: 'Replaced' });
    const dispose = registry.register(replacement, { override: true });
    expect(registry.resolve(hello.ref)).toBe(replacement);
    dispose();
    expect(registry.resolve(hello.ref)).toBe(hello);
  });

  test('lists the entities of one kind in id order', () => {
    const registry = new EntityRegistry();
    registry.register(definePrompt({ id: 'b', template: 'B' }));
    registry.register(definePrompt({ id: 'a', template: 'A' }));
    expect(registry.list('prompt').map((p) => p.ref.id)).toEqual(['a', 'b']);
  });

  test('has() reports presence without throwing', () => {
    const registry = new EntityRegistry();
    expect(registry.has(hello.ref)).toBe(false);
    registry.register(hello);
    expect(registry.has(hello.ref)).toBe(true);
  });

  test('disposing a registration twice is harmless', () => {
    const registry = new EntityRegistry();
    const dispose = registry.register(hello);
    dispose();
    dispose();
    expect(registry.has(hello.ref)).toBe(false);
  });
});

describe('registerEntity', () => {
  test('removes the entity when the registering plugin is disposed', async () => {
    const ctx = new Context();
    const registry = new EntityRegistry();
    ctx.provide('entities', registry);
    const fiber = await ctx.use(function plugin(inner: Context): void {
      registerEntity(inner, hello);
    });
    expect(registry.has(hello.ref)).toBe(true);
    await fiber.dispose();
    expect(registry.has(hello.ref)).toBe(false);
  });
});
