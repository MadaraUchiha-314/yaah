import { describe, expect, test } from 'bun:test';

import { SpeechError } from '../../src/harness/models/speech/types.ts';
import {
  ScriptedSpeechToText,
  ScriptedTextToSpeech,
  silencePerWord,
} from '../../src/testing/scripted-speech.ts';
import {
  SPEECH_CONTRACT_AUDIO,
  speechToTextContract,
  textToSpeechContract,
} from '../../src/testing/speech-contract.ts';

const live = (): AbortSignal => new AbortController().signal;
const failing = (retryable: boolean) => ({
  error: new SpeechError('scripted', 'scripted/model', retryable, 'scripted failure'),
});

speechToTextContract({ describe, expect, test }, 'scripted', {
  transcribes: () => new ScriptedSpeechToText(['Where is my order?']),
  retryableError: () => new ScriptedSpeechToText([failing(true)]),
  fatalError: () => new ScriptedSpeechToText([failing(false)]),
});

textToSpeechContract({ describe, expect, test }, 'scripted', {
  speaks: () => new ScriptedTextToSpeech(),
  retryableError: () => new ScriptedTextToSpeech([failing(true)]),
  fatalError: () => new ScriptedTextToSpeech([failing(false)]),
});

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of stream) {
    seen.push(value);
  }
  return seen;
}

describe('scripted speech models', () => {
  test('the speech-to-text double records its calls and repeats its last transcript', async () => {
    const model = new ScriptedSpeechToText(['one', 'two words'], { id: 'mine/stt' });
    expect(model.ref).toEqual({ kind: 'speech-to-text', id: 'mine/stt', version: null });
    const texts: string[] = [];
    for (let call = 0; call < 3; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      const events = await drain(model.transcribe(SPEECH_CONTRACT_AUDIO, live()));
      texts.push(events.at(-1)?.text ?? '');
    }
    expect(texts).toEqual(['one', 'two words', 'two words']);
    expect(model.calls.length).toBe(3);
    expect(model.calls[0]?.mediaType).toBe('audio/wav');
  });

  test('the text-to-speech double plays fixed chunks or chunks made from the text', async () => {
    const fixed = new ScriptedTextToSpeech([[Uint8Array.from([1, 2]), Uint8Array.from([3, 4])]]);
    expect((await drain(fixed.synthesize('anything', live()))).map((chunk) => [...chunk])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const perWord = new ScriptedTextToSpeech([silencePerWord(2)], { id: 'mine/tts' });
    expect((await drain(perWord.synthesize('three little words', live()))).length).toBe(3);
    expect(perWord.calls).toEqual(['three little words']);
    expect(perWord.ref.id).toBe('mine/tts');
  });

  test('an empty script fails clearly', async () => {
    const stt = await drain(
      new ScriptedSpeechToText([]).transcribe(SPEECH_CONTRACT_AUDIO, live()),
    ).catch((error: unknown) => error);
    expect(stt instanceof SpeechError && stt.message).toBe('the script is empty');
    const tts = await drain(new ScriptedTextToSpeech([]).synthesize('x', live())).catch(
      (error: unknown) => error,
    );
    expect(tts instanceof SpeechError && tts.message).toBe('the script is empty');
  });

  test('an abort while a model waits ends the call', async () => {
    const controller = new AbortController();
    const model = new ScriptedTextToSpeech([silencePerWord()], { delayMs: 5000 });
    const pending = drain(model.synthesize('slow words', controller.signal)).catch(
      (error: unknown) => error,
    );
    controller.abort();
    const outcome = await pending;
    expect(outcome instanceof SpeechError && outcome.message).toBe('aborted');
  });
});
