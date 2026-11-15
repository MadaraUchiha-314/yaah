/**
 * Images waiting to be sent: read from a file picker or the clipboard, shown as
 * thumbnails above the input, each removable until the message goes.
 */
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../../../kernel/strings.ts';
import { dataUrl } from '../../../bytes.ts';
import type { TurnFile } from '../../../session.ts';

/** An image chosen and not yet sent. */
export interface Attachment {
  readonly id: string;
  readonly file: TurnFile;
  /** A `data:` URL of the image, for its thumbnail. */
  readonly preview: string;
}

let counter = 0;

/** Reads the images among `files`; anything that is not an image is left out. */
export function readAttachments(files: readonly File[]): Promise<Attachment[]> {
  const images = files.filter((file) => file.type.startsWith('image/'));
  return Promise.all(
    images.map(async (file): Promise<Attachment> => {
      const data = new Uint8Array(await file.arrayBuffer());
      counter += 1;
      return {
        id: `attachment-${String(counter)}`,
        file: { mediaType: file.type, name: file.name, data },
        preview: dataUrl(file.type, data),
      };
    }),
  );
}

/** Props of {@link AttachmentList}. */
export interface AttachmentListProps {
  readonly attachments: readonly Attachment[];
  readonly onRemove: (id: string) => void;
}

/** The thumbnails of what will be sent with the message. */
export function AttachmentList({ attachments, onRemove }: AttachmentListProps): ReactNode {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t('web.attach.list')} className="flex w-full flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => {
        const name = attachment.file.name ?? '';
        return (
          <li key={attachment.id} data-slot="attachment" className="relative">
            <img
              src={attachment.preview}
              alt={name === '' ? t('view.file.image') : name}
              className="size-16 rounded-lg border object-cover"
            />
            <button
              type="button"
              aria-label={t('web.attach.remove', { name })}
              className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-foreground"
              onClick={() => {
                onRemove(attachment.id);
              }}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
