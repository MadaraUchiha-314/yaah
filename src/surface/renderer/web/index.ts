/**
 * The web renderer as an entity. This file names what the browser application can draw
 * and imports nothing from it, so the server side can load it without React.
 */
import { LOCAL } from '../../../kernel/entity.ts';
import { t } from '../../../kernel/strings.ts';
import type { Renderer } from '../../types.ts';

/** The id of the A2UI 1.0 basic catalog, the one catalog the web chat draws. */
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** The web chat's renderer: React, shadcn/ui, and the official A2UI React renderer. */
export const webRenderer: Renderer = {
  ref: { kind: 'renderer', id: 'web', version: null },
  description: t('web.renderer.description'),
  locality: LOCAL,
  a2uiCatalogs: [BASIC_CATALOG_ID],
};
