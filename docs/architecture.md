# Architecture and design notes

## Why this shape

Two common alternatives, and why this project does neither:

- **Browser → Gemini Live directly**, using Gemini's own voice. Simple, but you can't choose the voice, and the browser needs a Gemini key or token.
- **A relay built for phone lines**, with Gemini as brain and Cartesia as voice. Phone lines have no echo cancellation, so such relays run half-duplex: the mic is gated while the agent speaks, and interruptions are ignored for a while after each turn starts.

Here the browser has acoustic echo cancellation, so the call is **full-duplex**. The relay stays because:
- keys and prompts stay on the server;
- the Gemini → Cartesia text hop runs server-to-server instead of round-tripping through the browser;
- the same `VoiceSession` can later sit behind a telephony transport.

## Data flow per reply

1. The browser's capture worklet resamples the mic to 16 kHz PCM16. It applies a 63-tap windowed-sinc low-pass first, then sends 20 ms binary frames over `/ws`.
2. `GeminiBrain` forwards the frames to Gemini Live. Gemini's server VAD decides when the user has finished.
3. Gemini generates audio, which is ignored, plus `outputTranscription` text deltas.
4. `SpeechChunker` turns the deltas into chunks:
   - the first complete words go out immediately;
   - after that, chunks end at sentence ends, at long clauses, or at a hard word-boundary cap.
5. `CartesiaVoice` pushes the chunks into one Cartesia context per reply, with `max_buffer_delay_ms: 0` because the chunker already buffers. Generation config sets speed and volume.
6. Audio chunks go back as binary frames. The browser's player worklet queues them and reports `playback: true/false`.
7. On `generationComplete` (or `turnComplete`), the chunker flushes and `no_more_inputs` is sent.

Consecutive agent turns (for example greeting, then reply) are **sequenced**: a later turn's audio is buffered until the earlier one has been fully sent, so voices never interleave.

## Barge-in

The agent counts as **audible** while any turn's audio is unsent, or while the browser reports that it is playing.

There are three triggers:

| Trigger | When it applies |
| --- | --- |
| Gemini `interrupted` | Gemini is generating, or still in its own virtual-playback window (Gemini delays `turnComplete` until its own audio would have finished playing). |
| Gemini `voiceActivity` `ACTIVITY_START` (~0.4 s after speech starts) | The agent is audible and Gemini is idle: the greeting, or the tail of a reply that Cartesia speaks more slowly than Gemini. |
| User transcript, at least `BARGE_IN_MIN_CHARS` letters | A fallback for the same idle window. Gemini delivers input transcription only at the end of the utterance, so this path is slow. |

On barge-in:
- every queued Cartesia context is cancelled;
- the browser gets `clear` and flushes its player immediately;
- each cut turn gets `agent_turn_end { interrupted: true }`, including a turn that was only still playing in the browser.

A second signal for the same speech is a no-op.

User transcripts that arrive while Gemini is still generating are **not** barge-in triggers. They are usually the tail of the utterance being answered.

## Measured behaviour (October 2026, gemini-3.8-live + sonic-3.6, Georgian)

- **End-of-speech to first agent audio:** about 1.1–1.8 s.
  - Gemini: ~1.0–1.5 s from the last voiced frame to its first text, including the 600 ms VAD silence.
  - Cartesia: ~125–160 ms from the first chunk to the first audio.
- **Before the chunker change:** waiting for a full sentence, with Cartesia's default 3 s buffer, cost another 350–700 ms. Gemini's transcript arrives in bursts 150–600 ms apart.
- **Barge-in:** 360–460 ms from the start of the user's speech to `clear`.

## API quirks found while building this

- `gemini-3.8-live` is native-audio only. A `TEXT` response modality is not available.
- `voiceActivity` arrives on the wire as `{ type: 'ACTIVITY_START' | 'ACTIVITY_END', audioOffset }`, although the SDK types say `voiceActivityType`. `GeminiBrain` accepts both.
- Input transcription comes once, about 0.8 s after the utterance ends. `interimInputTranscription` is not sent.
- `inputAudioTranscription: { languageCodes: ['ka'] }` is accepted and fixes Georgian transcripts. Auto-detect sometimes produced Portuguese or German for Georgian speech.
- Cartesia answers late messages for a cancelled context with an "Invalid context ID" error event. This is harmless and filtered out.
- Gemini may switch reply language when it mishears. The server always appends a "reply only in `<language>`" rule tied to `CARTESIA_LANGUAGE`.

## Session lifetime

- `contextWindowCompression: { slidingWindow: {} }` lifts the 15-minute audio session cap.
- `sessionResumption` handles are tracked. On `goAway`, the brain reconnects once Gemini is idle and the latest handle covers everything said. On an unexpected close it resumes with the latest handle.
- Mic audio is buffered (up to ~3 s) while reconnecting.

## Extending

- **Tools:** handle `message.toolCall` in `GeminiBrain.handleMessage`, answer with `session.sendToolResponse`, and pass `tools` in `buildConfig`. `VoiceSession` needs no change.
- **Telephony:** write another transport next to `browserSocket.ts` that feeds 16 kHz PCM into `VoiceSession.handleMicAudio` and plays `sendAudio` output. Phone lines have no browser AEC, so expect to need echo handling there.
