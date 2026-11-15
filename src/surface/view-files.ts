/**
 * Files in a task's view: an image the user attached or the agent produced, a voice
 * message — and the spoken form of an answer, which is not part of the view at all but
 * a stream of audio for a surface to play.
 */
import type { Artifact, Part } from '@a2a-js/sdk';

import { EXT, SCHEMAS } from '../app/api-server/extensions/index.ts';
import { t } from '../kernel/strings.ts';
import { dataUrl } from './bytes.ts';

/** What a file is, in a word or two, for a renderer's label. */
export function fileLabel(item: FileItem): string {
  if (item.mediaType.startsWith('image/')) {
    return t('view.file.image');
  }
  if (item.mediaType.startsWith('audio/')) {
    return t(item.from === 'user' ? 'view.file.voice' : 'view.file.audio');
  }
  return t('view.file.other');
}

/** The file's address when it is an absolute `https:` link — the only kind shown as a link. */
export function fileLink(item: FileItem): string | null {
  try {
    return item.url !== null && new URL(item.url).protocol === 'https:' ? item.url : null;
  } catch {
    return null;
  }
}

/** Where a file is, in words: at its link, or with the task under its id. */
export function fileLocation(item: FileItem): string {
  const link = fileLink(item);
  return link === null
    ? t('view.file.where.task', { id: item.id })
    : t('view.file.where.link', { url: link });
}

/** A file in the transcript. */
export interface FileItem {
  readonly kind: 'file';
  /** `<message or artifact id>/<index of the part>`. */
  readonly id: string;
  /** Who it came from. */
  readonly from: 'user' | 'agent';
  /** `image/png`, `audio/webm`, … */
  readonly mediaType: string;
  /** The file's name, or empty when it has none. */
  readonly name: string;
  /**
   * Where the content is: a `data:` URL holding an inline image, or the link of linked
   * content, exactly as the sender gave it. Null for inline content that is not an image —
   * it is not kept in the view. A renderer decides whether a URL is safe to use.
   */
  readonly url: string | null;
}

/** One piece of an answer's spoken form, ready to play. */
export interface SpeechChunk {
  /** The id of the `speech` artifact: the same for every piece of one answer. */
  readonly artifactId: string;
  /** Signed 16-bit little-endian samples. */
  readonly data: Uint8Array;
  readonly sampleRate: number;
  readonly channels: number;
  /** True on the last piece. */
  readonly last: boolean;
}

/** A media type safe to write into a `data:` URL: an image type and nothing else. */
const IMAGE_TYPE = /^image\/[\w.+-]+$/u;

function fileItem(part: Part, id: string, from: FileItem['from']): FileItem | null {
  const { content } = part;
  const base = { kind: 'file', id, from, mediaType: part.mediaType, name: part.filename } as const;
  if (content?.$case === 'url') {
    return { ...base, url: content.value };
  }
  if (content?.$case !== 'raw') {
    return null;
  }
  return {
    ...base,
    url: IMAGE_TYPE.test(part.mediaType) ? dataUrl(part.mediaType, content.value) : null,
  };
}

/** The files among `parts`, as transcript items. */
export function fileItems(
  parts: readonly Part[],
  ownerId: string,
  from: FileItem['from'],
): FileItem[] {
  return parts.flatMap(
    (part: Part, index: number) => fileItem(part, `${ownerId}/${String(index)}`, from) ?? [],
  );
}

/** Whether an artifact is the spoken form of an answer rather than content to show. */
export function isSpeech(artifact: Artifact | undefined): boolean {
  return artifact?.extensions.includes(EXT.voice) === true;
}

/** The audio of one `speech` artifact update, or null when it carries none. */
export function speechChunk(artifact: Artifact | undefined, last: boolean): SpeechChunk | null {
  if (artifact === undefined || !isSpeech(artifact)) {
    return null;
  }
  const metadata: Readonly<Record<string, unknown>> = { ...artifact.metadata };
  const format = SCHEMAS.voiceAudio.safeParse(metadata[EXT.voice]);
  const content = artifact.parts[0]?.content;
  if (!format.success || content?.$case !== 'raw') {
    return null;
  }
  return {
    artifactId: artifact.artifactId,
    data: content.value,
    sampleRate: format.data.sampleRate,
    channels: format.data.channels,
    last,
  };
}
