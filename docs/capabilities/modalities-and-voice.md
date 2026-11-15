# Capability: Images, audio and voice

> Show the agent a picture, or talk to it.

## What it is

A message may carry an image or an audio recording. What happens to it depends on what the selected model accepts and on whether speech models are configured. Speech-to-text and text-to-speech are entity kinds with OpenAI implementations; both are **off until configured** (`[speech] stt`, `tts`).

## Current behaviour

- WHEN a message carries an image or audio part and the selected model accepts that modality THEN the system SHALL pass it to the model; otherwise it SHALL reply, without calling the model, that the model does not accept it, naming both.
- WHEN an audio part arrives for a model that does not accept audio and `speech.stt` is configured THEN the system SHALL transcribe it once and show the model the transcript.
- The system SHALL NOT download a link it is given: an `https:` image link is passed on only to a provider that accepts links, and any other link is refused.
- IF a binary part exceeds `limits.max_part_bytes` THEN the system SHALL refuse the message before a task exists.
- WHEN the agent calls `generate_image` THEN the image SHALL be delivered as an A2A artifact; the web chat shows it and the terminal chat names it.
- WHEN a client asks for spoken output (the `voice` extension) and `speech.tts` is configured THEN the system SHALL stream synthesised audio as it is produced, sentence by sentence, as `audio/pcm` artifact chunks alongside the text. A failing voice SHALL NOT fail the answer.
- Web chat: the attach button takes images; the microphone records and sends the recording as the turn; a switch turns spoken answers on. IF the microphone is unavailable or denied THEN the chat SHALL say so and text input SHALL keep working.
- Terminal chat: Space on an empty input line records (held where the terminal reports key release, otherwise pressed again to send) by spawning `arecord`, `pw-record` or `ffmpeg`; IF none is available THEN it SHALL say so and text input SHALL keep working. It does not play audio.

## Design

- [design.md — Models; Surfaces and renderers (voice)](../specs/issue-3/design.md#models)
- Schema: [`specs/a2a-extensions/voice.v1.schema.json`](../../specs/a2a-extensions/voice.v1.schema.json)
- Not yet verified against live services: OpenAI transcription, Realtime speech and image generation run on hand-written fixtures; no real microphone or speaker was used.

## History

| Work item | What changed | Links                             |
| --------- | ------------ | --------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), PR #13 |
