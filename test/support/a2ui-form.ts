/**
 * A2UI fixtures for the renderer tests: one surface that uses every component of the
 * basic catalog, as messages and as the A2UI Express text a scripted model writes.
 */
import { BASIC_CATALOG_ID } from '../../src/surface/renderer/tui/a2ui-model.ts';

const path = (at: string): { '@path': string } => ({ '@path': at });

/** Message batches that build a refund form progressively, the way the harness streams. */
export function refundForm(): unknown[] {
  const update = (...components: unknown[]): unknown[] => [
    { version: '1.0', updateComponents: { surfaceId: 'main', components } },
  ];
  return [
    [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'main',
          catalogId: BASIC_CATALOG_ID,
          components: [{ id: 'root', component: 'Card', child: 'col' }],
          dataModel: { reason: ['damaged'], photo: false, notes: '', amount: 20, when: '' },
        },
      },
    ],
    update({
      id: 'col',
      component: 'Column',
      children: ['title', 'reason', 'photo', 'notes', 'amount', 'when', 'div', 'row', 'extras'],
    }),
    update({ id: 'title', component: 'Text', text: 'Refund details' }),
    update({
      id: 'reason',
      component: 'ChoicePicker',
      label: 'What happened?',
      variant: 'mutuallyExclusive',
      options: [
        { label: 'Arrived damaged', value: 'damaged' },
        { label: 'Wrong item', value: 'wrong' },
        { label: 'Never arrived', value: 'missing' },
      ],
      value: path('/reason'),
    }),
    update({
      id: 'photo',
      component: 'CheckBox',
      label: 'I can send a photo of the damage',
      value: path('/photo'),
    }),
    update({
      id: 'notes',
      component: 'TextField',
      label: 'Notes',
      value: path('/notes'),
      placeholder: 'anything else',
    }),
    update({
      id: 'amount',
      component: 'Slider',
      label: 'Amount',
      min: 0,
      max: 100,
      value: path('/amount'),
    }),
    update({
      id: 'when',
      component: 'DateTimeInput',
      value: path('/when'),
      enableDate: true,
      label: 'Delivered on',
    }),
    update({ id: 'div', component: 'Divider' }),
    update({ id: 'row', component: 'Row', children: ['submit', 'skip'] }),
    update(
      {
        id: 'submit',
        component: 'Button',
        child: 'submit_child',
        variant: 'primary',
        action: {
          event: {
            name: 'submitRefund',
            context: { reason: path('/reason'), photo: path('/photo'), notes: path('/notes') },
          },
        },
      },
      { id: 'submit_child', component: 'Text', text: 'Submit' },
    ),
    update(
      { id: 'skip', component: 'Button', child: 'skip_child', action: { event: { name: 'skip' } } },
      { id: 'skip_child', component: 'Text', text: 'Skip' },
    ),
    update(
      { id: 'extras', component: 'List', direction: 'horizontal', children: ['tabs', 'modal'] },
      { id: 'tabs', component: 'Tabs', tabs: [{ title: 'Policy', child: 'policy' }] },
      { id: 'policy', component: 'Text', text: 'Refunds within 30 days.' },
      { id: 'modal', component: 'Modal', trigger: 'help', content: 'media' },
      { id: 'help', component: 'Button', child: 'help_icon', action: { event: { name: 'help' } } },
      { id: 'help_icon', component: 'Icon', name: 'help' },
      { id: 'media', component: 'Column', children: ['img', 'video', 'audio'] },
      {
        id: 'img',
        component: 'Image',
        url: 'https://example.com/lamp.png',
        description: 'The lamp',
      },
      { id: 'video', component: 'Video', url: 'https://example.com/lamp.mp4' },
      { id: 'audio', component: 'AudioPlayer', url: 'https://example.com/lamp.mp3' },
    ),
  ];
}

/** The same kind of form as the model writes it, for a scripted turn. */
export const REFUND_FORM_TEXT: string = [
  'Please fill this in.',
  '<a2ui>',
  '$/reason = ["damaged"]',
  '$/photo = false',
  'root = Column([title, reason, photo, submit])',
  'title = Text("Refund details")',
  'reason = ChoicePicker("What happened?", "mutuallyExclusive", [{label: "Arrived damaged", value: "damaged"}, {label: "Wrong item", value: "wrong"}], $/reason)',
  'photo = CheckBox("I can send a photo", $/photo)',
  'submit = Button(Text("Submit refund"), "primary", Event("submitRefund", {reason: $/reason, photo: $/photo}))',
  '</a2ui>',
].join('\n');

/** A surface whose only component is outside the catalog. */
export function hostileSurface(): unknown[] {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'bad',
        catalogId: BASIC_CATALOG_ID,
        components: [{ id: 'root', component: 'ScriptTag', code: 'alert(1)' }],
      },
    },
  ];
}
