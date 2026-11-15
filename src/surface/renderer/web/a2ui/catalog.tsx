/**
 * The catalog the web chat draws A2UI with: the official basic catalog of A2UI 1.0, with
 * the three places a URL chosen by the agent reaches the browser replaced by strict ones —
 * `Image`, `Video`, `AudioPlayer` and the `openUrl` function (abuse case 5).
 */
import type { ReactCatalogComponent } from '@a2ui/react';
import { createComponentImplementation } from '@a2ui/react';
import {
  AudioPlayerApi,
  BASIC_FUNCTIONS,
  Catalog,
  ImageApi,
  OpenUrlApi,
  VideoApi,
  basicCatalog,
  createFunctionImplementation,
} from '@a2ui/web_core/v1_0';
import type { FunctionImplementation } from '@a2ui/web_core/v1_0';
import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import { isSafeImage, isSafeLink } from './safety.ts';

/** A property an agent set, when it is text. */
function textOf(value: unknown, otherwise: string): string {
  return typeof value === 'string' ? value : otherwise;
}

/** The text shown in place of something the page will not load. */
export function Fallback({ component }: { readonly component: string }): ReactNode {
  return (
    <p data-slot="a2ui-fallback" className="text-sm text-muted-foreground">
      {t('view.a2ui.fallback', { component })}
    </p>
  );
}

const SafeImage = createComponentImplementation(ImageApi, ({ props }): ReactNode =>
  isSafeImage(props.url) ? (
    <img
      src={props.url}
      alt={textOf(props.description, '')}
      className="max-w-full rounded-md"
      referrerPolicy="no-referrer"
    />
  ) : (
    <Fallback component={ImageApi.name} />
  ),
);

const SafeVideo = createComponentImplementation(VideoApi, ({ props }): ReactNode =>
  isSafeLink(props.url) ? (
    <video src={props.url} controls className="max-w-full rounded-md" />
  ) : (
    <Fallback component={VideoApi.name} />
  ),
);

const SafeAudio = createComponentImplementation(AudioPlayerApi, ({ props }): ReactNode =>
  isSafeLink(props.url) ? (
    <audio src={props.url} controls aria-label={textOf(props.description, AudioPlayerApi.name)} />
  ) : (
    <Fallback component={AudioPlayerApi.name} />
  ),
);

/** `openUrl`, opening `https:` links only, in a new tab that cannot reach this page. */
const safeOpenUrl: FunctionImplementation = createFunctionImplementation(
  OpenUrlApi,
  (args): void => {
    if (isSafeLink(args.url)) {
      window.open(args.url, '_blank', 'noopener,noreferrer');
    }
  },
);

const REPLACED: ReadonlyMap<string, ReactCatalogComponent> = new Map([
  [ImageApi.name, SafeImage],
  [VideoApi.name, SafeVideo],
  [AudioPlayerApi.name, SafeAudio],
]);

function components(): ReactCatalogComponent[] {
  return [...basicCatalog.components.values()].map(
    (component): ReactCatalogComponent => REPLACED.get(component.name) ?? component,
  );
}

function functions(): FunctionImplementation[] {
  return BASIC_FUNCTIONS.map((implementation) =>
    implementation.name === OpenUrlApi.name ? safeOpenUrl : implementation,
  );
}

/** The basic catalog, hardened. Its id is the basic catalog's, so agents address it as such. */
export const webCatalog: Catalog<ReactCatalogComponent> = new Catalog(
  basicCatalog.id,
  '1.0',
  components(),
  functions(),
  basicCatalog.themeSchema,
);

/** The names of the components {@link webCatalog} can draw. */
export const KNOWN_COMPONENTS: ReadonlySet<string> = new Set(webCatalog.components.keys());
