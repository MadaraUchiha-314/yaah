/**
 * The voice plugin: connects the configured speech models to the task loop and declares
 * the `voice` A2A extension.
 *
 * - `speech.stt` names the `speech-to-text` entity that transcribes an audio turn for a
 *   model that does not accept audio.
 * - `speech.tts` names the `text-to-speech` entity that speaks an answer. It is used only
 *   on a turn whose message asks for it: `{ "<voice extension URI>": { "output": true } }`
 *   in the message metadata. The audio is streamed while the answer is written.
 *
 * A model named in the configuration and not registered is treated as absent.
 */
import type { Context } from 'cordis';

import { EXT, SCHEMAS } from '../../app/api-server/extensions/index.ts';
import type { EntityKind, EntityOf } from '../../kernel/entity.ts';
import type { TaskSnapshot } from '../core/task-port.ts';
import type { SpeechToText, TextToSpeech } from '../models/speech/types.ts';

declare module 'cordis' {
  interface Events {
    /** Speaking an answer failed part-way; the answer's text was delivered regardless. */
    'speech/failed'(taskId: string, reason: string): void;
  }
}

export const name = 'voice';
export const inject: readonly string[] = ['a2a', 'taskRuntime', 'config', 'entities'];

/** Whether the latest message of `task` asks for a spoken answer. */
export function wantsSpeech(task: TaskSnapshot): boolean {
  const asked = SCHEMAS.voiceRequest.safeParse(task.turnMetadata[EXT.voice]);
  return asked.success && asked.data.output === true;
}

/** Starts the voice plugin. */
export function apply(ctx: Context): void {
  const { speech } = ctx.config;
  const find = <K extends EntityKind>(kind: K, id: string): EntityOf<K> | null => {
    const ref = { kind, id, version: null };
    return id !== '' && ctx.entities.has(ref) ? ctx.entities.resolve(ref) : null;
  };
  ctx.effect(() =>
    ctx.taskRuntime.setSpeech({
      stt: (): SpeechToText | null => find('speech-to-text', speech.stt),
      tts: (task: TaskSnapshot): TextToSpeech | null =>
        wantsSpeech(task) ? find('text-to-speech', speech.tts) : null,
      onError: (taskId: string, error: unknown): void => {
        ctx.emit('speech/failed', taskId, error instanceof Error ? error.message : String(error));
      },
    }),
  );
  ctx.effect(() =>
    ctx.a2a.addExtension({
      uri: EXT.voice,
      description: 'Spoken answers: audio streamed as artifact chunks while the text is written.',
      required: false,
      params: { transcription: speech.stt !== '', output: speech.tts !== '' },
    }),
  );
}
