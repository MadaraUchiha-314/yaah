/**
 * Images and audio on their way to a model. Before a conversation becomes a request,
 * every image or audio file in it is checked against what the selected model accepts:
 *
 * - accepted, and inline — it goes to the model as it is;
 * - accepted, as a link — it goes as a link only when the provider fetches `https:` links
 *   itself. The harness never downloads a link it was given;
 * - audio the model does not accept, with a speech-to-text model configured — it is
 *   transcribed once, and the transcript is what the model sees;
 * - anything else, in the turn being worked — the turn is answered without calling the
 *   model, saying which model does not accept which modality;
 * - anything else, in an earlier turn — a short note stands in its place, so a
 *   conversation is not stuck on a file an earlier model could not read.
 */
import type { EntityRegistry } from '../../kernel/registry.ts';
import { t } from '../../kernel/strings.ts';
import type { LLM } from '../models/llm/types.ts';
import type { SpeechToText } from '../models/speech/types.ts';
import { transcriptOf } from '../models/speech/types.ts';
import { renderPrompt } from '../system-prompt/prompt.ts';
import type { StepContext } from './direct-runner.ts';
import type { StateStore } from './persistence.ts';
import type { ContentPart, ConversationEvent } from './types.ts';

/** An input modality beyond text. */
export type Modality = 'image' | 'audio';

/** A file content part. */
export type FilePart = Extract<ContentPart, { type: 'file' }>;

/** What {@link prepareMedia} works with. */
export interface MediaDeps {
  readonly registry: EntityRegistry;
  readonly state: StateStore;
  /** The configured speech-to-text model, or null when there is none. */
  readonly stt?: (() => SpeechToText | null) | undefined;
}

/** A conversation ready for a model, or the reason the turn cannot go to it. */
export interface PreparedMedia {
  readonly events: readonly ConversationEvent[];
  /** What to answer instead of calling the model, or null. */
  readonly refusal: string | null;
}

/** The modality of a file part, or null when it is neither an image nor audio. */
export function modalityOf(part: FilePart): Modality | null {
  if (part.mediaType.startsWith('image/')) {
    return 'image';
  }
  return part.mediaType.startsWith('audio/') ? 'audio' : null;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Why a file cannot go to the model as it is, or null when it can. */
function obstacle(llm: LLM, part: FilePart, modality: Modality): 'modality' | 'link' | null {
  if (!llm.capabilities.input.includes(modality)) {
    return 'modality';
  }
  if (part.source.kind === 'base64') {
    return null;
  }
  const byLink = llm.capabilities.inputUrls?.includes(modality) === true;
  return byLink && isHttps(part.source.url) ? null : 'link';
}

function refusalText(llm: LLM, modality: Modality, why: 'modality' | 'link'): string {
  const params = { model: llm.ref.id, modality: t(`media.modality.${modality}`) };
  return t(why === 'link' ? 'media.refused.link' : 'media.refused.modality', params);
}

/** State name under which the transcript of one audio part is kept. Never shown to the model. */
function transcriptName(seq: number, index: number): string {
  return `yaah.transcript/${String(seq)}/${String(index)}`;
}

interface Pass {
  readonly deps: MediaDeps;
  readonly ctx: StepContext;
  readonly llm: LLM;
  /** Events after this sequence number belong to the turn being worked. */
  readonly turnStart: number;
  refusal: string | null;
}

/** The transcript of an audio part: read from the task's state, or made and stored there. */
async function transcript(
  pass: Pass,
  stt: SpeechToText,
  part: FilePart,
  name: string,
): Promise<string> {
  const { ctx, deps } = pass;
  const stored = await deps.state.get(ctx.taskId, name);
  if (typeof stored === 'string') {
    return stored;
  }
  const data = part.source.kind === 'base64' ? part.source.data : '';
  const audio = { data: Uint8Array.from(Buffer.from(data, 'base64')), mediaType: part.mediaType };
  const text = await transcriptOf(stt, audio, ctx.signal);
  await deps.state.set(ctx.taskId, ctx.key, name, text);
  return text;
}

/** What the model is shown for one part. */
async function shown(
  pass: Pass,
  part: ContentPart,
  seq: number,
  index: number,
): Promise<ContentPart> {
  const modality = part.type === 'file' ? modalityOf(part) : null;
  if (part.type !== 'file' || modality === null) {
    return part;
  }
  const why = obstacle(pass.llm, part, modality);
  if (why === null) {
    return part;
  }
  const stt = pass.deps.stt?.() ?? null;
  if (why === 'modality' && modality === 'audio' && part.source.kind === 'base64' && stt !== null) {
    return { type: 'text', text: await transcript(pass, stt, part, transcriptName(seq, index)) };
  }
  if (seq > pass.turnStart) {
    pass.refusal ??= refusalText(pass.llm, modality, why);
  }
  const note = renderPrompt(pass.deps.registry, 'media-omitted', {
    modality: t(`media.modality.${modality}`),
  });
  return { type: 'text', text: note };
}

function partsOf(event: ConversationEvent): readonly ContentPart[] {
  if (event.type === 'message' && event.role === 'user') {
    return event.parts;
  }
  return event.type === 'tool-result' && event.result.ok ? event.result.content : [];
}

function withParts(event: ConversationEvent, parts: readonly ContentPart[]): ConversationEvent {
  if (event.type === 'message') {
    return { ...event, parts };
  }
  return event.type === 'tool-result' && event.result.ok
    ? { ...event, result: { ...event.result, content: parts } }
    : event;
}

function hasMedia(event: ConversationEvent): boolean {
  return partsOf(event).some(
    (part: ContentPart) => part.type === 'file' && modalityOf(part) !== null,
  );
}

/**
 * Makes `events` fit for `llm`: transcribes, replaces or refuses, as the head of this
 * file describes. Events without images or audio are returned as they are.
 *
 * @throws SpeechError when a transcription fails.
 */
export async function prepareMedia(
  deps: MediaDeps,
  ctx: StepContext,
  llm: LLM,
  events: readonly ConversationEvent[],
): Promise<PreparedMedia> {
  if (!events.some((event: ConversationEvent) => hasMedia(event))) {
    return { events, refusal: null };
  }
  const lastAnswer = events.findLast(
    (event: ConversationEvent) => event.type === 'message' && event.role === 'agent',
  );
  const pass: Pass = { deps, ctx, llm, turnStart: lastAnswer?.seq ?? -1, refusal: null };
  const prepared: ConversationEvent[] = [];
  for (const event of events) {
    if (hasMedia(event)) {
      const parts: ContentPart[] = [];
      for (const [index, part] of partsOf(event).entries()) {
        // oxlint-disable-next-line no-await-in-loop -- parts are transcribed one at a time, in order
        parts.push(await shown(pass, part, event.seq, index));
      }
      prepared.push(withParts(event, parts));
    } else {
      prepared.push(event);
    }
  }
  return { events: prepared, refusal: pass.refusal };
}
