/**
 * A file in the conversation: an image is drawn, anything else is named. Where a file
 * came from an agent, its address is data: an image is loaded only from `https:` or an
 * inline `data:image/`, and a link is offered only to `https:`.
 */
import { ImageIcon, MicIcon, PaperclipIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import type { FileItem } from '../../../view-files.ts';
import { fileLabel, fileLink } from '../../../view-files.ts';
import { isSafeImage } from '../a2ui/safety.ts';
import { plainText } from '../lib/text.ts';
import { cn } from '../lib/utils.ts';

function Glyph({ item }: { item: FileItem }): ReactNode {
  if (item.mediaType.startsWith('image/')) {
    return <ImageIcon aria-hidden="true" className="size-3.5" />;
  }
  return item.mediaType.startsWith('audio/') ? (
    <MicIcon aria-hidden="true" className="size-3.5" />
  ) : (
    <PaperclipIcon aria-hidden="true" className="size-3.5" />
  );
}

/** The label of a file: what it is, its name, and a link when it has a safe one. */
function Caption({ item, shown }: { item: FileItem; shown: boolean }): ReactNode {
  const link = fileLink(item);
  const name = plainText(item.name);
  const isImage = item.mediaType.startsWith('image/');
  return (
    <figcaption className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Glyph item={item} />
      <span>{fileLabel(item)}</span>
      {name !== '' && <span className="font-medium text-foreground">{name}</span>}
      {link !== null && !shown && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
          {t('web.file.open')}
        </a>
      )}
      {isImage && !shown && link === null && <span>{t('web.file.hidden')}</span>}
    </figcaption>
  );
}

/** One file of the transcript. */
export function FileBlock({ item }: { readonly item: FileItem }): ReactNode {
  const isImage = item.mediaType.startsWith('image/');
  const shown = isImage && isSafeImage(item.url);
  return (
    <figure
      data-slot={isImage ? 'image' : 'file'}
      data-from={item.from}
      className={cn('flex flex-col gap-1.5', item.from === 'user' ? 'items-end' : 'items-start')}
    >
      {shown && (
        <img
          src={item.url ?? undefined}
          alt={plainText(item.name) === '' ? fileLabel(item) : plainText(item.name)}
          className="max-h-80 max-w-full rounded-xl border object-contain"
        />
      )}
      <Caption item={item} shown={shown} />
    </figure>
  );
}
