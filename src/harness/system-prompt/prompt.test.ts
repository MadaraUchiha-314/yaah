import { describe, expect, test } from 'bun:test';

import { PromptVariableError } from '../../kernel/errors.ts';
import { EntityRegistry } from '../../kernel/registry.ts';
import { definePrompt, renderPrompt } from './prompt.ts';

describe('prompt entities', () => {
  test('declares the variables its template uses', () => {
    const prompt = definePrompt({ id: 'p', template: 'Hi {{name}}, you are {{role}}. {{name}}!' });
    expect(prompt.variables).toEqual(['name', 'role']);
  });

  test('renders with every variable supplied', () => {
    const prompt = definePrompt({ id: 'p', template: 'Hi {{ name }}.' });
    expect(prompt.render({ name: 'Ada' })).toBe('Hi Ada.');
  });

  test('throws a typed error naming the missing variable', () => {
    const prompt = definePrompt({ id: 'p', template: 'Hi {{name}}.' });
    expect(() => prompt.render({})).toThrow(PromptVariableError);
  });

  test('is local and unversioned by default', () => {
    const prompt = definePrompt({ id: 'p', template: 'x' });
    expect(prompt.ref).toEqual({ kind: 'prompt', id: 'p', version: null });
    expect(prompt.locality).toEqual({ type: 'local' });
  });

  test('renderPrompt appends registered extensions in id order', () => {
    const registry = new EntityRegistry();
    registry.register(definePrompt({ id: 'system', template: 'Base.' }));
    registry.register(
      definePrompt({ id: 'house-rules', template: 'Be brief.', extends: 'system' }),
    );
    registry.register(
      definePrompt({ id: 'tone', template: 'Be kind to {{who}}.', extends: 'system' }),
    );
    expect(renderPrompt(registry, 'system', { who: 'everyone' })).toBe(
      'Base.\n\nBe brief.\n\nBe kind to everyone.',
    );
  });

  test('renderPrompt uses an override in place of the default', () => {
    const registry = new EntityRegistry();
    registry.register(definePrompt({ id: 'system', template: 'Default.' }));
    registry.register(definePrompt({ id: 'system', template: 'Mine.' }), { override: true });
    expect(renderPrompt(registry, 'system', {})).toBe('Mine.');
  });
});
