import { describe, expect, test } from 'bun:test';

import { sampleSurface } from '../../../testing/renderer-contract.ts';
import { hostileSurface, refundForm } from '../../../../test/support/a2ui-form.ts';
import { A2uiModel, BASIC_CATALOG_ID } from './a2ui-model.ts';
import type { A2uiNode } from './a2ui-tree.ts';
import { controlsOf, titleOf, toNode } from './a2ui-tree.ts';

function modelOf(...batches: unknown[]): A2uiModel {
  const model = new A2uiModel();
  model.apply(batches);
  return model;
}

function rootOf(model: A2uiModel): A2uiNode | null {
  return model.surfaces()[0]?.root ?? null;
}

function kinds(node: A2uiNode | null): string[] {
  if (node === null) {
    return [];
  }
  return node.kind === 'group'
    ? [node.kind, ...node.children.flatMap((child) => kinds(child))]
    : [node.kind];
}

describe('A2UI model', () => {
  test('reads a surface into text and a button', () => {
    const root = rootOf(modelOf(sampleSurface()));
    expect(titleOf(root)).toBe('Refund details');
    expect(controlsOf(root)).toEqual([{ kind: 'button', id: 'submit', label: 'Submit refund' }]);
  });

  test('maps every component of the basic catalog', () => {
    const model = modelOf(...refundForm());
    const root = rootOf(model);
    expect(model.rejected).toBe(0);
    expect(root?.kind === 'group' && root.framed).toBe(true);
    expect(new Set(kinds(root))).toEqual(
      new Set([
        'group',
        'text',
        'choice',
        'checkbox',
        'field',
        'slider',
        'divider',
        'button',
        'media',
      ]),
    );
    const controls = controlsOf(root);
    expect(controls.map((control) => control.id)).toEqual([
      'reason',
      'photo',
      'notes',
      'amount',
      'when',
      'submit',
      'skip',
      'help',
    ]);
    expect(controls[0]).toMatchObject({ multiple: false, selected: ['damaged'] });
    expect(controls[3]).toMatchObject({ min: 0, max: 100, step: 5, value: 20 });
    expect(controls.at(-1)).toMatchObject({ kind: 'button', label: 'Icon help' });
    expect(JSON.stringify(root)).toContain('https://example.com/lamp.mp4');
    expect(JSON.stringify(root)).toContain('[ Policy ]');
  });

  test('a value the user sets reaches the data model and the action context', async () => {
    const model = modelOf(...refundForm());
    model.surfaces();
    model.set('main', 'photo', true);
    model.set('main', 'reason', ['wrong']);
    model.set('main', 'notes', 'box was crushed');
    const controls = controlsOf(rootOf(model));
    expect(controls[1]).toMatchObject({ checked: true });
    const action = await model.activate('main', 'submit');
    expect(action).toMatchObject({
      name: 'submitRefund',
      surfaceId: 'main',
      sourceComponentId: 'submit',
      context: { reason: ['wrong'], photo: true, notes: 'box was crushed' },
    });
    expect(Number.isNaN(Date.parse(action?.timestamp ?? ''))).toBe(false);
    expect(await model.activate('main', 'nope')).toBeNull();
    expect(await model.activate('main', 'title')).toBeNull();
  });

  test('a control that is not bound keeps the value the user gave it', () => {
    const model = modelOf([
      {
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          catalogId: BASIC_CATALOG_ID,
          components: [{ id: 'root', component: 'CheckBox', label: 'Agree', value: false }],
        },
      },
    ]);
    model.surfaces();
    model.set('s', 'root', true);
    expect(controlsOf(rootOf(model))[0]).toMatchObject({ checked: true });
  });

  test('a component outside the catalog becomes a fallback that carries only its name', () => {
    const root = rootOf(modelOf(hostileSurface()));
    expect(root).toEqual({ kind: 'fallback', id: 'root', component: 'ScriptTag' });
  });

  test('malformed batches are counted and never throw', () => {
    const model = modelOf(42, null, [{ nonsense: true }], 'text', [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'x',
          catalogId: BASIC_CATALOG_ID,
          components: [{ id: 'root', component: 'Text', text: 42 }],
        },
      },
    ]);
    expect(model.rejected).toBeGreaterThanOrEqual(3);
    expect(model.surfaces().every((surface) => surface.root === null)).toBe(true);
    model.set('x', 'root', 1);
    model.dispose();
  });

  test('batches already applied are not applied twice, and escapes are filtered', () => {
    const model = new A2uiModel();
    const batches = refundForm();
    model.apply(batches.slice(0, 3));
    model.apply(batches);
    model.apply([
      ...batches,
      [
        {
          version: '1.0',
          updateComponents: {
            surfaceId: 'main',
            components: [{ id: 'title', component: 'Text', text: 'Safe\u001B]0;owned\u0007' }],
          },
        },
      ],
    ]);
    expect(model.rejected).toBe(0);
    expect(titleOf(rootOf(model))).toBe('Safe');
  });

  test('a batch list that does not extend the one fed starts the surfaces over', () => {
    const model = new A2uiModel();
    model.apply(refundForm());
    const form = rootOf(model);
    // The step was retried: the answer keeps its id and carries a new, shorter list.
    model.apply([sampleSurface()]);
    expect(rootOf(model)).not.toEqual(form);
    expect(rootOf(model)).toEqual(rootOf(modelOf(sampleSurface())));
    expect(model.surfaces()).toHaveLength(1);
    model.dispose();
  });

  test('a reference cycle and a missing child draw nothing', () => {
    const root = rootOf(
      modelOf([
        {
          version: '1.0',
          createSurface: {
            surfaceId: 'c',
            catalogId: BASIC_CATALOG_ID,
            components: [
              { id: 'root', component: 'Column', children: ['later', 'text'] },
              { id: 'text', component: 'Text', text: 'kept' },
            ],
          },
        },
      ]),
    );
    expect(kinds(root)).toEqual(['group', 'text']);
  });
});

describe('A2UI tree', () => {
  test('ignores what is not a component and stops at a depth limit', () => {
    expect(toNode('text')).toBeNull();
    expect(toNode({ id: 'a', type: 'Text', state: 'cyclic' })).toBeNull();
    expect(toNode({ id: 'a', type: 'Text', text: 'x' }, 99)).toBeNull();
    expect(toNode({ id: 'a', type: 'constructor' })).toEqual({
      kind: 'fallback',
      id: 'a',
      component: 'constructor',
    });
    expect(controlsOf(null)).toEqual([]);
    expect(titleOf(null)).toBe('');
    expect(titleOf({ kind: 'divider', id: 'd' })).toBe('');
  });

  test('reads loosely typed properties without failing', () => {
    expect(
      toNode({ id: 's', type: 'Slider', min: 0, max: 10, steps: 5, value: 'x' }),
    ).toMatchObject({ step: 2, value: 0 });
    expect(
      toNode({ id: 'c', type: 'ChoicePicker', options: ['bad', { label: 1, value: true }] }),
    ).toMatchObject({ multiple: true, options: [{ label: '1', value: 'true' }], selected: [] });
    expect(toNode({ id: 't', type: 'Tabs', tabs: ['bad'] })).toMatchObject({ children: [] });
    expect(
      toNode({
        id: 'b',
        type: 'Button',
        child: {
          id: 'g',
          type: 'Row',
          children: [
            { id: 'x', type: 'Text', text: 'Go' },
            { id: 'y', type: 'CheckBox', label: 'now' },
            { id: 'z', type: 'Divider' },
          ],
        },
      }),
    ).toMatchObject({ label: 'Go now ' });
    expect(toNode({ id: 'b', type: 'Button' })).toMatchObject({ label: '' });
  });
});
